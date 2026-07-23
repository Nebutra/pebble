import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflowPath = resolve(
  import.meta.dirname,
  '../../.github/workflows/tauri-desktop-release.yml'
)

function releaseWorkflow() {
  return parse(readFileSync(workflowPath, 'utf8'))
}

const releaseCutPath = resolve(import.meta.dirname, '../../.github/workflows/release-cut.yml')

describe('Tauri release workflow signing gate', () => {
  it('is reusable by the single release-cut publisher and has no competing tag trigger', () => {
    const workflow = releaseWorkflow()
    expect(workflow.on.workflow_call.inputs).toEqual(
      expect.objectContaining({
        ref: expect.objectContaining({ required: true }),
        release_tag: expect.objectContaining({ required: true }),
        upload_to_github_release: expect.objectContaining({ required: true })
      })
    )
    expect(workflow.on.push).toBeUndefined()
  })

  it('commits one synchronized version across every Tauri package source before tagging', () => {
    const workflow = parse(readFileSync(releaseCutPath, 'utf8'))
    const bumpStep = workflow.jobs.cut.steps.find(
      ({ name }) => name === 'Bump package.json and tag'
    )

    expect(bumpStep.run).toContain('sync-tauri-release-version.mjs "$VERSION"')
    expect(bumpStep.run).toContain('verify-tauri-version-sync.mjs')
    expect(bumpStep.run).toContain('apps/desktop/package.json')
    expect(bumpStep.run).toContain('apps/desktop/src-tauri/Cargo.toml')
    expect(bumpStep.run).toContain('apps/desktop/src-tauri/Cargo.lock')
  })

  it('maps every native runner to an explicit target triple', () => {
    const matrix = releaseWorkflow().jobs.build.strategy.matrix.include
    expect(
      matrix.map(({ label, platform, target_triple: targetTriple }) => [
        label,
        platform,
        targetTriple
      ])
    ).toEqual([
      ['macos-universal', 'macos', 'universal-apple-darwin'],
      ['linux-x64', 'linux', 'x86_64-unknown-linux-gnu'],
      ['linux-arm64', 'linux', 'aarch64-unknown-linux-gnu'],
      ['windows-x64', 'windows', 'x86_64-pc-windows-msvc']
    ])
  })

  it('checks out the requested release ref in every job', () => {
    const workflow = releaseWorkflow()
    const checkoutSteps = [
      workflow.jobs.build,
      workflow.jobs['verify-updater-manifest'],
      workflow.jobs['verify-release-evidence']
    ].map((job) => job.steps.find(({ uses }) => uses === 'actions/checkout@v6'))

    expect(checkoutSteps).toHaveLength(3)
    expect(checkoutSteps.every((step) => step.with.ref === '${{ inputs.ref }}')).toBe(true)
  })

  it('builds a notarizable macOS app and DMG installer', () => {
    const macos = releaseWorkflow().jobs.build.strategy.matrix.include.find(
      ({ platform }) => platform === 'macos'
    )

    expect(macos.args).toContain('--bundles app,dmg')
  })

  it('pins every platform installer format required by artifact inspection', () => {
    const matrix = releaseWorkflow().jobs.build.strategy.matrix.include
    const argumentsByLabel = Object.fromEntries(matrix.map(({ label, args }) => [label, args]))

    expect(argumentsByLabel).toEqual({
      'linux-arm64': '--bundles deb',
      'linux-x64': '--bundles deb',
      'macos-universal': '--target universal-apple-darwin --bundles app,dmg',
      'windows-x64': '--bundles nsis,msi'
    })
  })

  it('keeps Linux out of the updater manifest until a self-contained package exists', () => {
    const verifyStep = releaseWorkflow().jobs['verify-updater-manifest'].steps.find(
      ({ name }) => name === 'Verify published signed platform matrix'
    )

    expect(verifyStep.env.TAURI_REQUIRED_UPDATER_PLATFORMS).toBe(
      'darwin-aarch64,darwin-x86_64,windows-x86_64'
    )
  })

  it('preflights credentials before build and inspects artifacts before evidence upload', () => {
    const steps = releaseWorkflow().jobs.build.steps
    const names = steps.map((step) => step.name)
    const apiKeyIndex = names.indexOf('Prepare App Store Connect API key')
    const preflightIndex = names.indexOf('Verify release signing and sidecar preflight')
    const buildIndex = names.indexOf('Build Tauri desktop bundle')
    const inspectIndex = names.indexOf('Inspect signed release artifacts and sidecars')
    const uploadIndex = names.indexOf('Upload release inspection evidence')

    expect(apiKeyIndex).toBeGreaterThan(-1)
    expect(apiKeyIndex).toBeLessThan(preflightIndex)
    expect(preflightIndex).toBeLessThan(buildIndex)
    expect(buildIndex).toBeLessThan(inspectIndex)
    expect(inspectIndex).toBeLessThan(uploadIndex)
    expect(steps[inspectIndex].run).toContain('--target-triple ${{ matrix.target_triple }}')
    expect(steps[inspectIndex].env.APPLE_TEAM_ID).toContain("matrix.platform == 'macos'")
    expect(steps[inspectIndex].env.TAURI_UPDATER_PUBLIC_KEY).toBe(
      '${{ secrets.TAURI_UPDATER_PUBLIC_KEY }}'
    )
    expect(steps[preflightIndex].env).toEqual(
      expect.objectContaining({
        APPLE_API_KEY: "${{ matrix.platform == 'macos' && secrets.APPLE_API_KEY || '' }}",
        APPLE_API_ISSUER: "${{ matrix.platform == 'macos' && secrets.APPLE_API_ISSUER || '' }}",
        APPLE_API_KEY_PATH: "${{ matrix.platform == 'macos' && env.APPLE_API_KEY_PATH || '' }}",
        PEBBLE_MAC_RELEASE: "${{ matrix.platform == 'macos' && '1' || '' }}",
        TAURI_SIGNING_PRIVATE_KEY: '${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}',
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}',
        TAURI_UPDATER_PUBLIC_KEY: '${{ secrets.TAURI_UPDATER_PUBLIC_KEY }}'
      })
    )
  })

  it('executes renderer and native runtime gates on every release runner', () => {
    const steps = releaseWorkflow().jobs.build.steps
    const byName = Object.fromEntries(steps.map((step) => [step.name, step]))

    expect(byName['Test Tauri renderer bridge'].run).toContain('exec vitest run')
    expect(byName['Test Go runtime']).toEqual(
      expect.objectContaining({
        'working-directory': 'runtime/go',
        run: 'go test ./...'
      })
    )
    expect(byName['Test native Tauri host'].run).toBe(
      'cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features'
    )
    expect(byName['Exercise real Tauri runtime on Linux']).toEqual(
      expect.objectContaining({
        if: "runner.os == 'Linux'",
        run: 'xvfb-run --auto-servernum dbus-run-session -- pnpm verify:tauri-real-runtime'
      })
    )
    expect(byName['Exercise real Tauri runtime on macOS and Windows']).toEqual(
      expect.objectContaining({
        if: "runner.os != 'Linux'",
        run: 'pnpm verify:tauri-real-runtime'
      })
    )
    expect(byName['Exercise pixel and settings-performance parity on macOS']).toEqual(
      expect.objectContaining({
        if: "matrix.platform == 'macos'",
        run: 'pnpm verify:tauri-pixel-performance:capture',
        env: {
          PEBBLE_PIXEL_PERF_EVIDENCE_DIR: 'artifacts/tauri-pixel-performance'
        }
      })
    )
    expect(byName['Upload pixel and settings-performance evidence']).toEqual(
      expect.objectContaining({
        if: "${{ always() && matrix.platform == 'macos' }}",
        uses: 'actions/upload-artifact@v7',
        with: expect.objectContaining({
          name: 'tauri-pixel-performance-${{ matrix.label }}',
          'if-no-files-found': 'error'
        })
      })
    )
  })

  it('materializes the preferred API key only on macOS without exposing P8 to Tauri', () => {
    const steps = releaseWorkflow().jobs.build.steps
    const prepareStep = steps.find((step) => step.name === 'Prepare App Store Connect API key')
    const buildStep = steps.find((step) => step.name === 'Build Tauri desktop bundle')

    expect(prepareStep).toEqual(
      expect.objectContaining({
        if: "matrix.platform == 'macos'",
        env: { APPLE_API_KEY_P8: '${{ secrets.APPLE_API_KEY_P8 }}' },
        run: 'node config/scripts/prepare-apple-api-key.mjs'
      })
    )
    expect(buildStep.env).toEqual(
      expect.objectContaining({
        APPLE_API_KEY: "${{ matrix.platform == 'macos' && secrets.APPLE_API_KEY || '' }}",
        APPLE_API_ISSUER: "${{ matrix.platform == 'macos' && secrets.APPLE_API_ISSUER || '' }}",
        APPLE_API_KEY_PATH: "${{ matrix.platform == 'macos' && env.APPLE_API_KEY_PATH || '' }}"
      })
    )
    expect(buildStep.env.APPLE_API_KEY_P8).toBeUndefined()
  })

  it('keeps the complete Apple ID notarization fallback mapped to Tauri', () => {
    const buildStep = releaseWorkflow().jobs.build.steps.find(
      (step) => step.name === 'Build Tauri desktop bundle'
    )

    expect(buildStep.env).toEqual(
      expect.objectContaining({
        PEBBLE_BUILD_IDENTITY: expect.stringContaining("'rc' || 'stable'"),
        PEBBLE_DIAGNOSTICS_TOKEN_URL: 'https://pebble.nebutra.com/diagnostics/token',
        PEBBLE_MAC_RELEASE: "${{ matrix.platform == 'macos' && '1' || '' }}",
        APPLE_CERTIFICATE: "${{ matrix.platform == 'macos' && secrets.MAC_CERTS || '' }}",
        APPLE_CERTIFICATE_PASSWORD:
          "${{ matrix.platform == 'macos' && secrets.MAC_CERTS_PASSWORD || '' }}",
        APPLE_ID: "${{ matrix.platform == 'macos' && secrets.APPLE_ID || '' }}",
        APPLE_PASSWORD:
          "${{ matrix.platform == 'macos' && secrets.APPLE_APP_SPECIFIC_PASSWORD || '' }}",
        APPLE_TEAM_ID: "${{ matrix.platform == 'macos' && secrets.APPLE_TEAM_ID || '' }}"
      })
    )
  })

  it('imports the real Windows PFX before preparing the ephemeral signing config', () => {
    const steps = releaseWorkflow().jobs.build.steps
    const importIndex = steps.findIndex(({ name }) => name === 'Import Windows release certificate')
    const prepareIndex = steps.findIndex(
      ({ name }) => name === 'Prepare signed updater configuration'
    )
    const preflightIndex = steps.findIndex(
      ({ name }) => name === 'Verify release signing and sidecar preflight'
    )

    expect(importIndex).toBeGreaterThan(-1)
    expect(importIndex).toBeLessThan(prepareIndex)
    expect(prepareIndex).toBeLessThan(preflightIndex)
    expect(steps[importIndex].env).toEqual({
      WINDOWS_CERTIFICATE: '${{ secrets.WINDOWS_CERTIFICATE }}',
      WINDOWS_CERTIFICATE_PASSWORD: '${{ secrets.WINDOWS_CERTIFICATE_PASSWORD }}'
    })
    expect(steps[prepareIndex].env.TAURI_RELEASE_PLATFORM).toBe('${{ matrix.platform }}')
    expect(steps[prepareIndex].env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBe(
      '${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}'
    )
    const inspect = steps.find(
      ({ name }) => name === 'Inspect signed release artifacts and sidecars'
    )
    expect(inspect.env.PEBBLE_WINDOWS_EXPECTED_THUMBPRINTS).toContain(
      'env.TAURI_WINDOWS_CERTIFICATE_THUMBPRINT'
    )
  })

  it('blocks completion on the complete cross-runner evidence matrix', () => {
    const job = releaseWorkflow().jobs['verify-release-evidence']
    expect(job.needs).toBe('build')
    expect(job.steps.find(({ uses }) => uses === 'actions/download-artifact@v8').with.pattern).toBe(
      'tauri-release-inspection-*'
    )
    expect(job.steps.at(-1).run).toContain('verify-tauri-release-evidence.mjs')
  })

  it('cryptographically verifies the updater payloads uploaded to the draft release', () => {
    const job = releaseWorkflow().jobs['verify-updater-manifest']
    const verifyStep = job.steps.find(
      ({ name }) => name === 'Verify published signed platform matrix'
    )

    expect(verifyStep.env.TAURI_UPDATER_PUBLIC_KEY).toBe('${{ secrets.TAURI_UPDATER_PUBLIC_KEY }}')
    expect(verifyStep.run).toContain('verify-tauri-updater-manifest.mjs')
  })
})

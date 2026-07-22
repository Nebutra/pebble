import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')

describe('computer-use e2e workflow', () => {
  it('runs computer-use e2e files serially because they share desktop focus', () => {
    const config = readFileSync(join(projectDir, 'tests/e2e/vitest.config.ts'), 'utf8')

    expect(config).toContain('fileParallelism: false')
  })

  it('guards e2e source against fragile fixed waits and stale element indexes', () => {
    const driver = readFileSync(join(projectDir, 'tests/e2e/helpers/computer-driver.ts'), 'utf8')
    const cliDriver = readFileSync(
      join(projectDir, 'tests/e2e/helpers/computer-cli-driver.ts'),
      'utf8'
    )
    const windowsStoreE2e = readFileSync(
      join(projectDir, 'tests/e2e/computer-windows-store.e2e.ts'),
      'utf8'
    )

    expect(driver).not.toContain('await delay(3500)')
    expect(driver).toContain("await waitForComputerWindowTitle('gedit', fileName, 15000)")
    expect(cliDriver).toContain('PEBBLE_DEV_USER_DATA_PATH')
    expect(cliDriver).toContain('pebble-computer-runtime-')
    expect(cliDriver).toContain('retryMissingRuntimeMetadata')
    expect(cliDriver).toContain('Could not read Pebble runtime metadata')
    expect(cliDriver).toContain("'serve', '--no-pairing', '--json'")

    expect(windowsStoreE2e).toMatch(
      /for \(const buttonName of \['One', 'Plus', 'Two', 'Equals'\]\) \{[\s\S]*findRoleIndex\(state\.result\.snapshot\.treeText, `button \$\{buttonName\}`\)[\s\S]*state = parseJsonOutput/
    )
    expect(windowsStoreE2e).not.toMatch(/const one = findRoleIndex/)
    expect(windowsStoreE2e).not.toMatch(/for \(const index of \[one, plus, two, equals\]\)/)
  })

  it('triggers on computer-use shared contracts, scripts, and agent skill changes', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/computer-e2e.yml'), 'utf8')
    )
    const triggerPaths = workflow.on.pull_request.paths

    expect(triggerPaths).toEqual(
      expect.arrayContaining([
        'config/scripts/computer-e2e-workflow.test.mjs',
        'config/scripts/computer-use-skill-guidance.test.mjs',
        'config/scripts/computer-use-smoke.mjs',
        'config/scripts/computer-use-smoke.test.mjs',
        'skills/computer-use/SKILL.md',
        'apps/desktop/src-tauri/**',
        'packages/product-core/shared/computer-use-*.ts',
        'tests/e2e/vitest.config.ts'
      ])
    )
    expect(triggerPaths).not.toContain('packages/product-core/shared/runtime-types.ts')
  })

  it('runs focused computer-use regression tests in the PR native-smoke job', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/computer-e2e.yml'), 'utf8')
    )
    const nativeSmokeRuns = workflow.jobs['native-smoke'].steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')
    const regressionRun = nativeSmokeRuns.find((run) => run.includes('pnpm vitest run'))
    const expectedRegressionFiles = [
      'config/scripts/computer-e2e-workflow.test.mjs',
      'config/scripts/computer-use-skill-guidance.test.mjs',
      'config/scripts/computer-use-smoke.test.mjs',
      'packages/product-core/shared/computer-use-error-recovery.test.ts',
      'packages/product-core/shared/computer-use-key-spec.test.ts',
      'packages/product-core/cli/format.test.ts',
      'packages/product-core/cli/handlers/computer.test.ts',
      'packages/product-core/cli/handlers/computer-action-routing.test.ts',
      'packages/product-core/cli/handlers/computer-action-validation.test.ts',
      'packages/product-core/cli/handlers/computer-state-formatting.test.ts',
      'packages/product-core/cli/specs/computer.test.ts',
      'packages/product-core/cli/index.test.ts',
      'packages/product-core/cli/runtime/envelope-schema.test.ts',
      'packages/product-core/shared/remote-runtime-client.test.ts'
    ]

    expect(regressionRun).toBeTruthy()
    for (const file of expectedRegressionFiles) {
      expect(regressionRun).toContain(file)
    }
  })

  it('runs Linux computer-use e2e in the PR native-smoke job under Xvfb', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/computer-e2e.yml'), 'utf8')
    )
    const nativeSmokeRuns = workflow.jobs['native-smoke'].steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')
    const installRun = nativeSmokeRuns.find((run) => run.includes('apt-get install'))

    expect(installRun).toContain('gedit')
    expect(installRun).toContain('xvfb')
    expect(nativeSmokeRuns).toContain(
      'xvfb-run --auto-servernum dbus-run-session -- pnpm test:e2e:computer --reporter=verbose tests/e2e/computer-linux.e2e.ts'
    )
  })

  it('runs the Tauri computer-use Rust tests in PR smoke', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/computer-e2e.yml'), 'utf8')
    )

    const runs = workflow.jobs['native-smoke'].steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')
    expect(runs).toContain(
      'cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features computer_use'
    )
  })

  it('runs core Windows computer-use e2e in the PR native-smoke job', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/computer-e2e.yml'), 'utf8')
    )
    const nativeSmokeRuns = workflow.jobs['native-smoke'].steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')
    const allRuns = [
      ...nativeSmokeRuns,
      ...workflow.jobs.mac.steps.map((step) => step.run).filter((run) => typeof run === 'string'),
      ...workflow.jobs.linux.steps.map((step) => step.run).filter((run) => typeof run === 'string'),
      ...workflow.jobs.windows.steps
        .map((step) => step.run)
        .filter((run) => typeof run === 'string')
    ]

    expect(nativeSmokeRuns).toContain(
      'pnpm test:e2e:computer --reporter=verbose tests/e2e/computer-windows.e2e.ts'
    )
    expect(allRuns.join('\n')).not.toContain('test:e2e:computer -- --reporter')
  })

  it('runs macOS and Linux computer-use e2e files in scheduled jobs', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/computer-e2e.yml'), 'utf8')
    )
    const triggerPaths = workflow.on.pull_request.paths
    const macRuns = workflow.jobs.mac.steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')
    const linuxRuns = workflow.jobs.linux.steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')

    expect(triggerPaths).toEqual(
      expect.arrayContaining([
        'tests/e2e/computer-mac.e2e.ts',
        'tests/e2e/computer-mac-safari.e2e.ts',
        'tests/e2e/computer-linux.e2e.ts',
        'tests/e2e/helpers/computer-cli-driver.ts',
        'tests/e2e/helpers/computer-driver.ts'
      ])
    )
    expect(macRuns).toContain(
      'pnpm test:e2e:computer --reporter=verbose tests/e2e/computer-mac.e2e.ts tests/e2e/computer-mac-safari.e2e.ts'
    )
    expect(linuxRuns).toContain(
      'xvfb-run --auto-servernum dbus-run-session -- pnpm test:e2e:computer --reporter=verbose tests/e2e/computer-linux.e2e.ts'
    )
  })

  it('runs every Windows computer-use e2e file in the scheduled Windows job', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/computer-e2e.yml'), 'utf8')
    )
    const triggerPaths = workflow.on.pull_request.paths
    const windowsRuns = workflow.jobs.windows.steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')

    expect(triggerPaths).toEqual(
      expect.arrayContaining([
        'tests/e2e/computer-windows.e2e.ts',
        'tests/e2e/computer-windows-store.e2e.ts'
      ])
    )
    expect(windowsRuns).toContain(
      'pnpm test:e2e:computer --reporter=verbose tests/e2e/computer-windows.e2e.ts tests/e2e/computer-windows-store.e2e.ts'
    )
  })
})

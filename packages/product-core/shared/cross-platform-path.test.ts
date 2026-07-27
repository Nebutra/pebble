import { describe, expect, it } from 'vitest'
import {
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot,
  resolveRuntimePath
} from './cross-platform-path'

describe('cross-platform path containment', () => {
  it('keeps POSIX sibling prefixes outside the root', () => {
    expect(isPathInsideOrEqual('/repo/app', '/repo/app')).toBe(true)
    expect(isPathInsideOrEqual('/repo/app', '/repo/app/src/index.ts')).toBe(true)
    expect(isPathInsideOrEqual('/repo/app', '/repo/application/src/index.ts')).toBe(false)
    expect(relativePathInsideRoot('/repo/app/', '/repo/app/src/index.ts')).toBe('src/index.ts')
  })

  it('handles Windows drive roots and sibling drives case-insensitively', () => {
    expect(isPathInsideOrEqual('C:\\Repo', 'c:\\repo\\src\\index.ts')).toBe(true)
    expect(relativePathInsideRoot('C:\\Repo', 'c:\\repo\\src\\index.ts')).toBe('src/index.ts')
    expect(isPathInsideOrEqual('C:\\Repo', 'D:\\Repo\\src\\index.ts')).toBe(false)
    expect(relativePathInsideRoot('C:\\', 'c:\\repo\\src\\index.ts')).toBe('repo/src/index.ts')
  })

  it('handles UNC roots, trailing slashes, mixed separators, and case', () => {
    expect(isPathInsideOrEqual('\\\\Server\\Share\\Repo\\', '//server/share/repo/src')).toBe(true)
    expect(relativePathInsideRoot('\\\\Server\\Share\\Repo\\', '//server/share/repo/src')).toBe(
      'src'
    )
    expect(isPathInsideOrEqual('\\\\Server\\Share\\Repo', '\\\\server\\share\\repo2')).toBe(false)
  })

  it('matches macOS NFD paths against agent-recorded NFC paths', () => {
    // Regression for #10832 / upstream #10841: macOS file pickers hand decomposed
    // (NFD) paths while Claude Code records cwd in NFC, so a non-ASCII workspace
    // never matched its own sessions without folding.
    const nfc = '/Users/ada/내 드라이브/프로젝트'
    const nfd = nfc.normalize('NFD')
    expect(nfd).not.toBe(nfc)

    expect(normalizeRuntimePathForComparison(nfd)).toBe(normalizeRuntimePathForComparison(nfc))
    expect(isPathInsideOrEqual(nfd, `${nfc}/src`)).toBe(true)
    expect(isPathInsideOrEqual(nfc, `${nfd}/src`)).toBe(true)

    // WSL UNC keys return before the trailing fold, so they need NFC too.
    expect(
      normalizeRuntimePathForComparison(
        `\\\\wsl$\\Ubuntu\\home\\ada\\${'프로젝트'.normalize('NFD')}`
      )
    ).toBe(normalizeRuntimePathForComparison(`\\\\wsl.localhost\\Ubuntu\\home\\ada\\프로젝트`))
  })

  it('returns a byte-exact suffix when comparison folding changes length', () => {
    // Comparison folding (NFC, case) is not length-preserving, so slicing the raw
    // candidate by the folded root's length would cut mid-character and fabricate
    // a path — callers rejoin this suffix and hit the filesystem with it.
    const nfc = '/Users/ada/프로젝트'
    const nfd = nfc.normalize('NFD')
    for (const root of [nfc, nfd]) {
      for (const candidate of [nfc, nfd]) {
        expect(relativePathInsideRoot(root, `${candidate}/src/index.ts`)).toBe('src/index.ts')
      }
    }

    // Pre-existing over-slice: toLowerCase expands U+0130 to two UTF-16 units.
    expect(relativePathInsideRoot('C:\\İş', 'C:\\İş\\src\\a.ts')).toBe('src/a.ts')

    // U+212A KELVIN SIGN folds to 'K', so the root and candidate must agree on
    // Windows-ness or their segment counts desync and the suffix comes back ''.
    expect(relativePathInsideRoot('\u212A:/a\\b', '\u212A:/a\\b/c')).toBe(
      relativePathInsideRoot('K:/a\\b', 'K:/a\\b/c')
    )

    // Astral characters must not be cut mid-surrogate-pair.
    expect(relativePathInsideRoot('/repo/🚀app', '/repo/🚀app/src/🎉file.ts')).toBe('src/🎉file.ts')

    // A UNC-shaped candidate under POSIX root '/' used to yield a leading slash,
    // which is not a relative path.
    expect(relativePathInsideRoot('/', '//server/share/x')).toBe('server/share/x')

    // WSL suffixes must stay decomposed: they name files on a Linux filesystem,
    // where NFD and NFC are distinct entries.
    const decomposed = '프로젝트'.normalize('NFD')
    expect(
      relativePathInsideRoot(
        '\\\\wsl$\\Ubuntu\\home\\ada\\repo',
        `\\\\wsl.localhost\\Ubuntu\\home\\ada\\repo\\${decomposed}\\a.ts`
      )
    ).toBe(`${decomposed}/a.ts`)
  })

  it('resolves POSIX relative paths without using the process cwd', () => {
    expect(resolveRuntimePath('/repos/app/repo', '../worktrees/feature')).toBe(
      '/repos/app/worktrees/feature'
    )
    expect(resolveRuntimePath('/repos/app/repo', '/custom/worktrees')).toBe('/custom/worktrees')
    expect(isRuntimePathAbsolute('../worktrees')).toBe(false)
  })

  it('resolves Windows relative paths with Windows semantics', () => {
    expect(resolveRuntimePath('C:\\Repos\\app\\repo', '..\\worktrees\\feature')).toBe(
      'C:/Repos/app/worktrees/feature'
    )
    expect(resolveRuntimePath('C:\\Repos\\app\\repo', 'D:\\worktrees')).toBe('D:/worktrees')
    expect(isRuntimePathAbsolute('/remote/worktrees', 'windows')).toBe(true)
  })
})

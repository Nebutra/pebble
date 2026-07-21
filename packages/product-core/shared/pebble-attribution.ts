// Why: single source of truth for the commit trailer Pebble appends when the
// "Pebble Attribution" toggle (`enableGitHubAttribution`) is on. Used by both
// the terminal git/gh shim and the AI commit-message generator so the two
// code paths agree on the exact string.

export const PEBBLE_GIT_COMMIT_TRAILER = 'Co-authored-by: Pebble <help@nebutra.ai>'

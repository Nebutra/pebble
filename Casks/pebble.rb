cask "pebble" do
  arch arm: "arm64", intel: "x64"

  version "1.3.24"
  sha256 arm:   "fc707f290ff3b631b7b7947bf339885b61a43d2e89475997c125b61268ed4966",
         intel: "5f677c13a08f7a5740442e29d388285a86488c8c1f7aa5f10a8721a2c6ede8e4"

  url "https://github.com/nebutra/pebble/releases/download/v#{version}/pebble-macos-#{arch}.dmg",
      verified: "github.com/nebutra/pebble/"
  name "Pebble"
  desc "IDE for orchestrating AI coding agents across terminals and worktrees"
  homepage "https://pebble.nebutra.com/"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Why: Pebble's signed Tauri updater handles in-place application updates.
  # Marking the cask auto_updates
  # tells Homebrew not to compete with the in-app updater — `brew upgrade`
  # becomes a no-op unless the user passes --greedy, and brew's version
  # metadata stays aligned with whatever the app has swapped itself to.
  auto_updates true
  conflicts_with cask: "pebble@rc"
  depends_on macos: :big_sur

  app "Pebble.app"

  # Why: the Tauri executable owns both desktop activation and CLI dispatch, so
  # Homebrew must expose that native entrypoint instead of the removed Node shim.
  binary "#{appdir}/Pebble.app/Contents/MacOS/pebble-desktop-tauri", target: "pebble"

  # Why: Pebble writes user data under ~/.pebble (worktrees, agent state) and
  # Pebble's standard application-data directories. Zap removes everything the app
  # creates during normal use so `brew uninstall --zap` is a clean slate.
  zap trash: [
    "~/.pebble",
    "~/Library/Application Support/Pebble",
    "~/Library/Caches/com.nebutra.pebble",
    "~/Library/Caches/com.nebutra.pebble.ShipIt",
    "~/Library/HTTPStorages/com.nebutra.pebble",
    "~/Library/Preferences/com.nebutra.pebble.plist",
    "~/Library/Saved Application State/com.nebutra.pebble.savedState",
  ]
end

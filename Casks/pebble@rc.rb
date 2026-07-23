cask "pebble@rc" do
  arch arm: "arm64", intel: "x64"

  version "1.4.36-rc.3"
  sha256 arm:   "563b6b14323fc9d5489299c82442d514bc12cabffc9d06d3964ed572af4b3955",
         intel: "457088c7021f07de1a419197f7b2bd00092741ad4727d4fef3d86af38a6831e7"

  url "https://github.com/nebutra/pebble/releases/download/v#{version}/pebble-macos-#{arch}.dmg",
      verified: "github.com/nebutra/pebble/"
  name "Pebble RC"
  desc "IDE for orchestrating AI coding agents across terminals and worktrees"
  homepage "https://pebble.nebutra.com/"

  livecheck do
    url "https://github.com/nebutra/pebble"
    regex(/^v?(\d+(?:\.\d+)+-rc\.\d+)$/i)
    strategy :github_releases do |json, regex|
      json.map do |release|
        next if release["draft"]
        next unless release["prerelease"]

        match = release["tag_name"]&.match(regex)
        next if match.blank?

        match[1]
      end
    end
  end

  # Why: RC installs should follow Pebble's prerelease-aware updater instead of
  # waiting for Homebrew metadata churn between frequent release candidates.
  auto_updates true
  conflicts_with cask: "pebble"
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

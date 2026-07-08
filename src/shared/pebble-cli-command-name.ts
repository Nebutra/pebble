export function getPebbleCliCommandNameForPlatform(platform: NodeJS.Platform): string {
  if (platform === 'linux') {
    return 'pebble-ide'
  }
  if (platform === 'win32') {
    return 'pebble.cmd'
  }
  return 'pebble'
}

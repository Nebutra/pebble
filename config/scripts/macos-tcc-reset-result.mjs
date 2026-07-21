export function isMissingTccBundleRegistration(stderr) {
  const message = typeof stderr === 'string' ? stderr : ''
  return message.includes('No such bundle identifier') && message.includes('-10814')
}

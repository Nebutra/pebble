export async function waitForCleanExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return true
  }
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timeout)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

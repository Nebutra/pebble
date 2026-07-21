type StartedOperation = {
  started: boolean
  promise: Promise<void>
}

export class TauriUpdaterOperationState {
  private checkPromise: Promise<void> | null = null
  private downloadPromise: Promise<void> | null = null
  private relaunchPromise: Promise<void> | null = null

  startCheck(operation: () => Promise<void>): StartedOperation {
    if (this.checkPromise) {
      return { started: false, promise: this.checkPromise }
    }
    if (this.downloadPromise || this.relaunchPromise) {
      return { started: false, promise: Promise.resolve() }
    }

    const promise = operation().finally(() => {
      if (this.checkPromise === promise) {
        this.checkPromise = null
      }
    })
    this.checkPromise = promise
    return { started: true, promise }
  }

  startDownload(operation: () => Promise<void>): StartedOperation {
    if (this.downloadPromise) {
      return { started: false, promise: this.downloadPromise }
    }
    if (this.relaunchPromise) {
      return { started: false, promise: Promise.resolve() }
    }

    const start = async (): Promise<void> => {
      if (this.checkPromise) {
        await this.checkPromise
      }
      await operation()
    }
    const promise = start().finally(() => {
      if (this.downloadPromise === promise) {
        this.downloadPromise = null
      }
    })
    this.downloadPromise = promise
    return { started: true, promise }
  }

  startRelaunch(operation: () => Promise<void>): StartedOperation {
    if (this.relaunchPromise) {
      return { started: false, promise: this.relaunchPromise }
    }

    // Why: a successful relaunch must stay latched so a second renderer event
    // cannot start another install while the old process is shutting down.
    const promise = operation().catch((error) => {
      if (this.relaunchPromise === promise) {
        this.relaunchPromise = null
      }
      throw error
    })
    this.relaunchPromise = promise
    return { started: true, promise }
  }

  reset(): void {
    this.checkPromise = null
    this.downloadPromise = null
    this.relaunchPromise = null
  }
}

export type BrowserActionExecutor<TAction> = (
  action: TAction
) => Promise<Record<string, unknown> | void>

export type BrowserActionExecutorRegistration<TAction> = {
  pageId: string
  generation: number
  executor: BrowserActionExecutor<TAction>
}

export class BrowserActionExecutorRegistry<TAction> {
  private readonly registrations = new Map<string, BrowserActionExecutorRegistration<TAction>>()
  private nextGeneration = 1

  register(pageId: string, executor: BrowserActionExecutor<TAction>): () => void {
    const registration = {
      pageId,
      generation: this.nextGeneration++,
      executor
    }
    this.registrations.set(pageId, registration)
    return () => {
      if (this.isCurrent(registration)) {
        this.registrations.delete(pageId)
      }
    }
  }

  get(pageId: string): BrowserActionExecutorRegistration<TAction> | undefined {
    return this.registrations.get(pageId)
  }

  targets(): string[] {
    return [...this.registrations.keys()]
  }

  isCurrent(registration: BrowserActionExecutorRegistration<TAction>): boolean {
    return this.registrations.get(registration.pageId) === registration
  }
}

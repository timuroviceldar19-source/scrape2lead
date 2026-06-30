import type { ISourceAdapter, SourceId } from "../types.js";

export class AdapterRegistry {
  private readonly adapters = new Map<SourceId, ISourceAdapter>();

  register(adapter: ISourceAdapter): void {
    this.adapters.set(adapter.source, adapter);
  }

  resolve(source: SourceId): ISourceAdapter {
    const adapter = this.adapters.get(source);
    if (!adapter) {
      throw new Error(`No source adapter registered for '${source}'`);
    }
    return adapter;
  }
}

import { setWorldConstructor, World, IWorldOptions } from '@cucumber/cucumber';
import type { PeekOutcome } from '../../../src/commands/peekOutcome';

/** Cucumber world carrying the outcome of the last peek between When/Then steps. */
export class PeekWorld extends World {
  outcome?: PeekOutcome;

  constructor(options: IWorldOptions) {
    super(options);
  }
}

setWorldConstructor(PeekWorld);

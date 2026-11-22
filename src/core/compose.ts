// Answering composition (S-183): the one call a process's start-up wiring makes, once, after its
// start gate and before its front end accepts a request. Opens the one store with every table
// installer and builds the one core over it. Starts nothing, reads no environment of its own.

import type { SchemaInstaller, Store } from '../db/index';
import { openStore } from '../db/index';
import type { AnsweringCore } from './core';
import { CoreConfigError, createCore } from './core';
import type { Instant } from './primitives';
import type { EnvelopeContributor, Family, Settings } from './question';

export type StoreOpener = (location: string, schemas: readonly SchemaInstaller[]) => Store;
export interface AnsweringComposition {
  location: string;                          // the storage setting's value: MEMORY_LOCATION or a file path
  schemas: readonly SchemaInstaller[];       // the product's one declared list of table installers; required
  now: () => Instant;
  settings: () => Settings;                  // the process's question view of its settings record
  families: readonly Family[];               // every family the process serves
  contributors: readonly EnvelopeContributor[]; // every envelope contributor, in envelope order
  open?: StoreOpener;                        // absent means (l, s) => openStore(l, s, 'create')
}
export interface ComposedAnswering { readonly store: Store; readonly core: AnsweringCore }

const creating: StoreOpener = (l, s) => openStore(l, s, 'create');

export function composeAnswering(c: AnsweringComposition): ComposedAnswering {
  // An opener fault (StoreLocationError, StoreSchemaError, NoLocalCopyError) passes through here.
  const store = (c.open ?? creating)(c.location, c.schemas);
  let core: AnsweringCore;
  try {
    core = createCore({ store, now: c.now, settings: c.settings, families: c.families, contributors: c.contributors });
  } catch (e) {
    if (e instanceof CoreConfigError) store.close();
    throw e;
  }
  return Object.freeze({ store, core });
}

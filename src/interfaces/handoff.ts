// Front-end handoff (S-223): the one shape in which a process's composition hands a question front
// end its local copy and core, and the exit codes both front ends return. Shapes and codes only:
// the composition root builds the opener and its OpenedAnswering; the front end calls the opener at
// most once, after its parse and settings check, and closes what it opened exactly once.

import type { AnsweringCore } from '../core/core';

export type OpenRefusal =
  | { kind: 'no_local_copy'; location: string }              // no local copy at the location; nothing was created
  | { kind: 'open_failed'; location: string; why: string };  // any other refused open: not a store, schema not bringable current, lock not gained in its bounded wait, not readable
export interface OpenedAnswering {
  readonly core: AnsweringCore;   // built over the one store the opener opened, every family and contributor registered
  close(): void;                  // closes that store; a second call does nothing
}
export type AnsweringOpener = () => OpenedAnswering | OpenRefusal;

export function isOpenRefusal(x: OpenedAnswering | OpenRefusal): x is OpenRefusal {
  return Object.prototype.hasOwnProperty.call(x, 'kind');
}

export const EXIT_ANSWERED = 0; // an answer, an empty one included, or a command's help
export const EXIT_REFUSED = 1;  // a refused setting, a refused store open ('no local copy' included) or a question the core refused
export const EXIT_USAGE = 2;    // an unknown or missing command, or an option or value refused at parse
export const EXIT_WIRING = 70;  // a handed family with no catalogue entry, or an opener that threw

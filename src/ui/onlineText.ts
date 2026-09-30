// UI LAYER — what each server refusal means, in the player's terms (V1.5 Session 7;
// shared by the waiting room and the in-match panel).

import type { ErrorCode } from '../net/protocol';

export const ERROR_TEXT: Record<ErrorCode, string> = {
  BAD_MESSAGE: 'The server did not understand this browser. Try reloading the page.',
  VERSION_MISMATCH: 'This page is out of date with the server. Reload the page to update it.',
  NO_SUCH_ROOM: 'That room does not exist, or has closed.',
  ROOM_FULL: 'That room already has two players.',
  NOT_IN_ROOM: 'Not in a room yet.',
  ALREADY_IN_ROOM: 'Already in a room.',
  ILLEGAL_SETUP: 'The server refused that setup. Move something and try again.',
};

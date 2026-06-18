// Static election definition for this demo.
// A single election is hardcoded; there is no election-management API.

export const ELECTION_ID = 1n;

export const CANDIDATES: readonly string[] = [
  'Alice',
  'Bob',
  'Carol',
  'Dave',
];

// Mirrors the registration-closed flag from the Merkle tree so that the
// election-info endpoint can expose it without depending on merkle.ts directly.
// Updated by routes.ts whenever /close-registration is called successfully.
let _registrationClosed = false;

export function isRegistrationClosed(): boolean {
  return _registrationClosed;
}

export function markRegistrationClosed(): void {
  _registrationClosed = true;
}

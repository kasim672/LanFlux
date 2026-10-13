// Invitation joining is separate from file acceptance: incoming files still need consent.
export function invitedRoom(search) {
  const values = new URLSearchParams(search).getAll('room');
  if (!values.length) return null;
  if (values.length !== 1) throw new Error('This invitation contains multiple room codes. Ask the sender for a new link.');
  const code = values[0].replace(/[\s-]/g, '').toUpperCase();
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/.test(code)) {
    throw new Error('This invitation contains an invalid room code. Ask the sender for a new link, or create a room.');
  }
  return code;
}

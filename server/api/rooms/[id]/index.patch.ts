// PATCH /api/rooms/:id (rooms-backend): owner only (co-hosts 403 FORBIDDEN); `password: null` removes the password; a
// live meeting picks the changes up (publishRoomState). A new password costs an argon2 hash, so it counts against the
// owner's `room-create` limit like creating a room with one (F-016).
import { updateRoomSchema } from '#shared/schemas/rooms'
import { audit } from '../../../services/audit/audit'
import { requireRoomAccess, roomDetails, updateRoom } from '../../../services/rooms/rooms'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { room } = await requireRoomAccess(user.id, getRouterParam(event, 'id') ?? '', 'owner')
  const body = await readValidatedBody(event, updateRoomSchema.parse)
  if (typeof body.password === 'string') consumeOr429(event, 'room-create', userLimiterKey(user.id))
  const updated = await updateRoom(room, body)
  const fields = Object.entries(body)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
  if (fields.length) await audit(event, { action: 'room.updated', targetType: 'room', targetId: room.id, details: { fields } })
  return { room: await roomDetails(updated, user.id) }
})

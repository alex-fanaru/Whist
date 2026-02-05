# Auth + DB Plan (Supabase)

## Goals
- Login with Email/Password, Magic Link, and Google OAuth.
- Unique `username` per account.
- Allow per-room `nickname` while keeping account username stable.
- Ready for multiplayer + stats later.

## Auth (Supabase)
- Providers: Email/Password, Magic Link, Google.
- Store profile in `profiles` table keyed by `auth.users.id`.
- Require unique `username`.

## Database Schema (MVP)
### `profiles`
- `id` uuid (PK, references auth.users.id)
- `username` text (unique, not null)
- `created_at` timestamp (default now)

### `rooms`
- `id` uuid (PK)
- `name` text (not null)
- `owner_id` uuid (FK -> profiles.id)
- `created_at` timestamp (default now)
- `is_locked` boolean (default false)

### `room_members`
- `room_id` uuid (FK -> rooms.id)
- `user_id` uuid (FK -> profiles.id)
- `nickname` text (nullable)
- `joined_at` timestamp (default now)
- composite PK (`room_id`, `user_id`)

### `matches`
- `id` uuid (PK)
- `room_id` uuid (FK -> rooms.id)
- `started_at` timestamp
- `ended_at` timestamp (nullable)

## Flows
1. **Sign Up**
   - Auth via email/password or magic link or Google.
   - If no profile, ask for unique `username`.
2. **Create Room**
   - store in `rooms`
   - owner_id = current user
3. **Join Room**
   - create/update `room_members` with optional `nickname`
4. **Reconnect**
   - use `user_id` from session
   - rehydrate `room_members` nickname

## Notes
- `nickname` only affects display in the room.
- `username` is stable & globally unique.

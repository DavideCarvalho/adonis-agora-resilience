/**
 * Atomic Lua scripts for the Redis circuit-breaker store.
 *
 * Each circuit is a single Redis hash keyed by `<prefix><circuit-key>` with fields
 * `status` / `failures` / `openUntil` / `probes` — the serialised {@link CircuitState}. Running the
 * whole load→compute→persist cycle inside one Lua script makes it atomic on the Redis server, so
 * concurrent pods can never lose an update or hand out more than one half-open probe.
 *
 * The branching mirrors core's pure `computeAdmit` / `computeRecord` exactly, so a Redis-backed
 * circuit behaves identically to the in-memory and SQL stores.
 *
 * ARGV[last] of the mutating scripts is an optional `ttlMs`: when > 0 the hash is given a sliding
 * `PEXPIRE` on every write so idle circuits eventually evaporate (a never-seen key reads back as the
 * closed default anyway, so expiry is safe).
 */

/**
 * Atomic admit. KEYS[1] = circuit hash. ARGV: now, halfOpenMax, ttlMs.
 * Returns {allow(1/0), probe(1/0), status}.
 */
export const ADMIT_LUA = `
local h = KEYS[1]
local now = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

local function touch()
  if ttl > 0 then redis.call('PEXPIRE', h, ttl) end
end

local status = redis.call('HGET', h, 'status')
if status == false then status = 'closed' end
local openUntil = tonumber(redis.call('HGET', h, 'openUntil') or '0')
local probes = tonumber(redis.call('HGET', h, 'probes') or '0')

if status == 'open' and now >= openUntil then
  status = 'half-open'
  probes = 0
  redis.call('HSET', h, 'status', 'half-open', 'probes', 0)
  touch()
end

if status == 'closed' then
  return {1, 0, 'closed'}
end
if status == 'open' then
  return {0, 0, 'open'}
end
if probes < max then
  redis.call('HINCRBY', h, 'probes', 1)
  touch()
  return {1, 1, 'half-open'}
end
return {0, 0, 'half-open'}
`;

/**
 * Atomic record. KEYS[1] = circuit hash. ARGV: ok(1/0), probe(1/0), now, threshold, cooldownMs, ttlMs.
 * Returns the resulting status string.
 */
export const RECORD_LUA = `
local h = KEYS[1]
local ok = ARGV[1] == '1'
local probe = ARGV[2] == '1'
local now = tonumber(ARGV[3])
local threshold = tonumber(ARGV[4])
local cooldownMs = tonumber(ARGV[5])
local ttl = tonumber(ARGV[6])

local function touch()
  if ttl > 0 then redis.call('PEXPIRE', h, ttl) end
end

if probe then
  local p = tonumber(redis.call('HGET', h, 'probes') or '0')
  if p > 0 then redis.call('HINCRBY', h, 'probes', -1) end
end

if ok then
  redis.call('HSET', h, 'status', 'closed', 'failures', 0, 'openUntil', 0)
  touch()
  return 'closed'
end

local status = redis.call('HGET', h, 'status')
if status == false then status = 'closed' end

if probe or status == 'half-open' then
  redis.call('HSET', h, 'status', 'open', 'openUntil', now + cooldownMs)
  touch()
  return 'open'
end

local failures = redis.call('HINCRBY', h, 'failures', 1)
if failures >= threshold then
  redis.call('HSET', h, 'status', 'open', 'openUntil', now + cooldownMs)
  touch()
  return 'open'
end
touch()
return status
`;

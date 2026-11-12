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
 * Returns the resulting status string. A success on a circuit that is already closed with no failures
 * writes nothing (and so leaves its TTL alone: an expired clean circuit reads back identically).
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
  local current = redis.call('HGET', h, 'status')
  local clean = (current == false or current == 'closed')
    and tonumber(redis.call('HGET', h, 'failures') or '0') == 0
    and tonumber(redis.call('HGET', h, 'openUntil') or '0') == 0
  if not clean then
    redis.call('HSET', h, 'status', 'closed', 'failures', 0, 'openUntil', 0)
    touch()
  end
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

/**
 * Atomic bulkhead acquire. KEYS[1] = sorted set of slots (member = lease id, score = expiry).
 * ARGV: now, limit, leaseMs, leaseId. Returns {acquired(1/0), active}.
 */
export const BULKHEAD_ACQUIRE_LUA = `
local z = KEYS[1]
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local lease = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', z, '-inf', now)
local n = redis.call('ZCARD', z)
if n < limit then
  redis.call('ZADD', z, now + lease, ARGV[4])
  redis.call('PEXPIRE', z, lease)
  return {1, n + 1}
end
return {0, n}
`;

/** Release one slot. KEYS[1] = slots set. ARGV: leaseId. */
export const BULKHEAD_RELEASE_LUA = `
redis.call('ZREM', KEYS[1], ARGV[1])
return 1
`;

/** Count live slots. KEYS[1] = slots set. ARGV: now. */
export const BULKHEAD_COUNT_LUA = `
return redis.call('ZCOUNT', KEYS[1], '(' .. ARGV[1], '+inf')
`;

/**
 * Atomic token-bucket consume, mirroring `limits/token_bucket.ts`. KEYS[1] = bucket hash
 * (`tokens`, `updatedAt`). ARGV: now, ratePerMs, capacity, cost, ttlMs.
 * Returns {allowed(1/0), tokens (string), retryAfterMs (string)}.
 */
export const RATE_LIMIT_LUA = `
local h = KEYS[1]
local now = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local tokens = tonumber(redis.call('HGET', h, 'tokens'))
local updated = tonumber(redis.call('HGET', h, 'updatedAt'))
if tokens == nil or updated == nil then
  tokens = capacity
else
  local elapsed = now - updated
  if elapsed < 0 then elapsed = 0 end
  tokens = math.min(capacity, tokens + elapsed * rate)
end
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) / rate - 1e-9)
  if retry < 1 then retry = 1 end
end
redis.call('HSET', h, 'tokens', string.format('%.17g', tokens), 'updatedAt', now)
redis.call('PEXPIRE', h, ttl)
return {allowed, string.format('%.17g', tokens), string.format('%d', retry)}
`;

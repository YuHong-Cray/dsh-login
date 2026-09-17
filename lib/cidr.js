/**
 * dsh-login — IPv4 CIDR + loopback helpers. Self-contained (no package
 * imports): the gate must resolve from the profile's node_modules only.
 * IPv6 only recognizes ::1 and IPv4-mapped addresses.
 */

export function normalizePeerIp(addr) {
  if (typeof addr !== 'string' || addr.length === 0) return undefined
  let ip = addr
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  if (ip === '::1') return { kind: 'loopback6', text: ip }
  if (isIpv4(ip)) return { kind: isLoopbackV4(ip) ? 'loopback4' : 'v4', text: ip }
  return { kind: 'other', text: ip }
}

export function isLoopbackPeer(peer) {
  return peer !== undefined && (peer.kind === 'loopback4' || peer.kind === 'loopback6')
}

export function parseCidr(spec) {
  const raw = String(spec ?? '').trim()
  if (raw.length === 0) throw new Error('empty CIDR')
  const [ip, bitsRaw] = raw.split('/')
  if (!isIpv4(ip)) throw new Error(`CIDR must be IPv4: ${raw}`)
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) throw new Error(`bad prefix length: ${raw}`)
  const ipInt = ipv4ToInt(ip)
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return { spec: `${ip}/${bits}`, network: (ipInt & mask) >>> 0, mask, bits }
}

export function parseCidrList(list) {
  if (!Array.isArray(list)) throw new Error('allowCidrs must be an array of IPv4 CIDRs')
  return list.map((item) => parseCidr(item))
}

export function ipv4InCidrs(ip, cidrs) {
  if (!isIpv4(ip)) return false
  const n = ipv4ToInt(ip)
  return cidrs.some((c) => ((n & c.mask) >>> 0) === c.network)
}

export function isIpv4(ip) {
  const parts = String(ip).split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

function isLoopbackV4(ip) {
  return ip.split('.')[0] === '127'
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, p) => ((acc << 8) + Number(p)) >>> 0, 0)
}

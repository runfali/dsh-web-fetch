/**
 * CDP WebSocket 帧层测试（P2-2 修复：此前 encodeFrame/parseFrameHeader 零覆盖）。
 * 直接对导出的帧函数做 round-trip 与边界验证，无网络。
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { encodeFrame, parseFrameHeader } from "../src/strategies/cdp.js"

/** 完整解析：head + payload（含掩码解码，模拟对端收我方帧的视角） */
function decodeFrame(buf) {
  const header = parseFrameHeader(buf)
  assert.ok(header, "frame header must parse")
  let payload = buf.subarray(header.headerSize, header.headerSize + header.payloadLen)
  if (header.mask) {
    const mk = buf.subarray(header.consumed, header.consumed + 4)
    const dec = Buffer.alloc(payload.length)
    for (let i = 0; i < payload.length; i++) dec[i] = payload[i] ^ mk[i % 4]
    payload = dec
  }
  return { header, payload: payload.toString("utf8") }
}

describe("CDP frame encode/decode", () => {
  it("短帧（payload < 126 字节）round-trip 且带掩码", () => {
    const msg = '{"id":1,"method":"Page.enable"}'
    const buf = encodeFrame(msg)
    const { header, payload } = decodeFrame(buf)
    assert.equal(header.opcode, 0x1)
    assert.equal(header.mask, true, "client frames must be masked (RFC6455)")
    assert.equal(header.payloadLen, msg.length)
    assert.equal(payload, msg)
  })

  it("126 长帧（126..65535）round-trip", () => {
    const msg = "x".repeat(300)
    const buf = encodeFrame(msg)
    const { header, payload } = decodeFrame(buf)
    assert.equal(header.payloadLen, 300)
    assert.equal(payload, msg)
  })

  it("127 长帧（>65535）round-trip", () => {
    const msg = "y".repeat(70000)
    const buf = encodeFrame(msg)
    const { header, payload } = decodeFrame(buf)
    assert.equal(header.payloadLen, 70000)
    assert.equal(payload, msg)
  })

  it("解析拒绝超限帧（WS_MAX_FRAME）", () => {
    // 手工造 64bit 长度 = 0xFFFFFFFF（> 6MB）
    const buf = Buffer.alloc(10)
    buf[0] = 0x81
    buf[1] = 0x80 | 127
    buf.writeUInt32BE(0, 2)
    buf.writeUInt32BE(0x00ffffff, 6) // 16MB-ish
    assert.throws(() => parseFrameHeader(buf), /frame payload too large/)
  })

  it("空缓冲/不足头长度安全返回 null", () => {
    assert.equal(parseFrameHeader(Buffer.alloc(0)), null)
    assert.equal(parseFrameHeader(Buffer.from([0x81])), null)
  })
})

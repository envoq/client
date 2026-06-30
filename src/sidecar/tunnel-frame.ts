export const FrameType = {
    SYN: 0x01,
    DATA: 0x02,
    FIN: 0x03,
    RST: 0x04,
    PING: 0x05,
    PONG: 0x06
} as const;

export type FrameType = typeof FrameType[keyof typeof FrameType];

export interface TunnelFrame {
    streamId: number;
    frameType: FrameType;
    payload: Buffer;
}

export function formatFrame(streamId: number, frameType: FrameType, payload: Buffer): Buffer {
    const header = Buffer.alloc(9);
    header.writeUInt32BE(streamId, 0);
    header.writeUInt8(frameType, 4);
    header.writeUInt32BE(payload.length, 5);
    return Buffer.concat([header, payload]);
}

export function parseFrame(data: Buffer): TunnelFrame {
    if (data.length < 9) {
        throw new Error('Tunnel frame is too small to contain a header');
    }
    const streamId = data.readUInt32BE(0);
    const frameType = data.readUInt8(4) as FrameType;
    const payloadLength = data.readUInt32BE(5);
    if (data.length < 9 + payloadLength) {
        throw new Error(`Tunnel frame payload is truncated: expected ${payloadLength} bytes`);
    }
    return {
        streamId,
        frameType,
        payload: data.subarray(9, 9 + payloadLength)
    };
}

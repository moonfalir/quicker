import { HeaderParser } from "./header/header.parser";
import { BasePacket } from "./base.packet";
import { HeaderType, BaseHeader } from "./header/base.header";
import { LongHeader, LongHeaderType, Version } from "./header/long.header";
import { VersionNegotiationPacket } from "./packet/version.negotiation";
import { Constants } from "../utilities/constants";


export class PacketParser {
    private headerParser: HeaderParser;

    public constructor() {
        this.headerParser = new HeaderParser();
    }

    public parse(msg: Buffer): PacketOffset {
        var headerOffset = this.headerParser.parse(msg);
        var header = headerOffset.header;
        console.log(header.getHeaderType().toString());
        if (header.getHeaderType() === HeaderType.LongHeader) {
            return this.parseLongHeaderPacket(header, msg)
        }
        return this.parseShortHeaderPacket(header, msg, headerOffset.offset);
    }

    private parseLongHeaderPacket(header: BaseHeader, buffer: Buffer): PacketOffset {
        console.log("parsing long header packet");
        var offset = Constants.LONG_HEADER_SIZE;
        switch(header.getPacketType()) {
            case LongHeaderType.VersionNegotiation:
                return this.parseVersionNegotiationPacket(header, buffer, offset);;
            case LongHeaderType.Initial:
                // Initial
            case LongHeaderType.Retry:
                // Server Stateless Retry
            case LongHeaderType.Handshake:
                // Handshake
            case LongHeaderType.Protected0RTT:
                // 0-RTT Protected
                throw new Error("Method not implemented.");
            default:
                // Unknown packet type
                throw new Error("Unknown packet type.");
        }
    }

    private parseShortHeaderPacket(header: BaseHeader, buffer: Buffer, offset: number): PacketOffset {
        console.log("parse short header packet");
        throw new Error("Method not implemented.");
    }

    private parseVersionNegotiationPacket(header: BaseHeader, buffer: Buffer, offset: number): PacketOffset {
        var versions: Version[] = [];
        while(buffer.length > offset) {
            var version: Version = new Version(buffer.slice(offset, offset + 4));
            versions.push(version);
            offset += 4;
        }
        return {
            packet: new VersionNegotiationPacket(header, versions),
            offset: offset
        };
    }
}
/**
 * Interface so that the offset of the buffer is also returned
 */
export interface PacketOffset {
    packet: BasePacket, 
    offset: number
}
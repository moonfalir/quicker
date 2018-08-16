import { Alarm, AlarmEvent } from '../types/alarm';
import { TransportParameterType } from '../crypto/transport.parameters';
import { AEAD } from '../crypto/aead';
import { QTLS, HandshakeState, QuicTLSEvents } from '../crypto/qtls';
import { ConnectionID, PacketNumber, Version } from '../packet/header/header.properties';
import { Bignum } from '../types/bignum';
import { RemoteInfo, Socket } from "dgram";
import { Stream, StreamType, StreamState } from './stream';
import { EndpointType } from '../types/endpoint.type';
import { Constants } from '../utilities/constants';
import { TransportParameters } from '../crypto/transport.parameters';
import { BasePacket, PacketType } from '../packet/base.packet';
import { BaseEncryptedPacket } from '../packet/base.encrypted.packet';
import { AckHandler } from '../utilities/handlers/ack.handler';
import { PacketLogging } from '../utilities/logging/packet.logging';
import { FlowControlledObject } from '../flow-control/flow.controlled';
import { FlowControl } from '../flow-control/flow.control';
import { BaseFrame, FrameType } from '../frame/base.frame';
import { PacketFactory } from '../utilities/factories/packet.factory';
import { BN } from 'bn.js';
import { QuicStream } from './quic.stream';
import { FrameFactory } from '../utilities/factories/frame.factory';
import { HandshakeHandler } from '../utilities/handlers/handshake.handler';
import { LossDetection, LossDetectionEvents } from '../loss-detection/loss.detection';
import { QuicError } from '../utilities/errors/connection.error';
import { ConnectionErrorCodes } from '../utilities/errors/quic.codes';
import { QuickerError } from '../utilities/errors/quicker.error';
import { QuickerErrorCodes } from '../utilities/errors/quicker.codes';
import { StreamFrame } from '../frame/stream';
import { MaxStreamIdFrame } from '../frame/max.stream.id';
import { MaxStreamFrame } from '../frame/max.stream';
import { MaxDataFrame } from '../frame/max.data';
import { CongestionControl } from '../congestion-control/congestion.control';
import { StreamManager, StreamManagerEvents } from './stream.manager';

export class Connection extends FlowControlledObject {

    private qtls: QTLS;
    private aead: AEAD;
    private socket!: Socket;
    private remoteInfo: RemoteInformation;
    private endpointType: EndpointType;

    private ackHandler: AckHandler;
    private handshakeHandler!: HandshakeHandler;
    private lossDetection: LossDetection;
    private congestionControl: CongestionControl;
    private flowControl: FlowControl;

    private initialDestConnectionID!: ConnectionID;
    private srcConnectionID!: ConnectionID;
    private destConnectionID!: ConnectionID;
    private initialPacketNumber!: PacketNumber;
    private localPacketNumber!: PacketNumber;
    private remotePacketNumber!: PacketNumber;
    private localTransportParameters!: TransportParameters;
    private remoteTransportParameters!: TransportParameters;
    private version!: Version;

    private remoteMaxStreamUni!: Bignum;
    private remoteMaxStreamBidi!: Bignum;
    private localMaxStreamUni!: Bignum;
    private localMaxStreamBidi!: Bignum;
    private localMaxStreamUniBlocked: boolean;
    private localMaxStreamBidiBlocked: boolean;
    private spinBit: boolean;

    private earlyData?: Buffer;

    private state!: ConnectionState;
    private streamManager: StreamManager;

    private idleTimeoutAlarm: Alarm;
    private transmissionAlarm: Alarm;
    private closePacket!: BaseEncryptedPacket;
    private closeSentCount: number;

    public constructor(remoteInfo: RemoteInformation, endpointType: EndpointType, options?: any) {
        super();
        this.remoteInfo = remoteInfo;
        this.endpointType = endpointType;
        this.streamManager = new StreamManager(endpointType);
        this.hookStreamManagerEvents();
        this.idleTimeoutAlarm = new Alarm();
        this.transmissionAlarm = new Alarm();
        this.localMaxStreamUniBlocked = false;
        this.localMaxStreamBidiBlocked = false;
        this.closeSentCount = 0;
        this.spinBit = false;
        if (this.endpointType === EndpointType.Client) {
            this.version = new Version(Buffer.from(Constants.getActiveVersion(), "hex"));
        }

        // Create QuicTLS Object
        this.qtls = new QTLS(endpointType === EndpointType.Server, options, this);
        // Hook QuicTLS Events
        this.hookQuicTLSEvents();
        // Initialize QuicTLS Object
        this.qtls.init();

        this.aead = new AEAD(this.qtls);
        this.ackHandler = new AckHandler(this);
        this.handshakeHandler = new HandshakeHandler(this);

        this.lossDetection = new LossDetection(this);
        this.hookLossDetectionEvents();
        this.flowControl = new FlowControl(this);
        this.congestionControl = new CongestionControl(this, this.lossDetection);
    }

    private hookLossDetectionEvents() {
        this.lossDetection.on(LossDetectionEvents.RETRANSMIT_PACKET, (basePacket: BasePacket) => {
            this.retransmitPacket(basePacket);
        });
        this.lossDetection.on(LossDetectionEvents.PACKET_ACKED, (basePacket: BasePacket) => {
            this.ackHandler.onPacketAcked(basePacket);
        });
    }

    private hookQuicTLSEvents() {
        this.qtls.on(QuicTLSEvents.LOCAL_TRANSPORTPARAM_AVAILABLE, (transportParams: TransportParameters) => {
            this.setLocalTransportParameters(transportParams);
        });
        this.qtls.on(QuicTLSEvents.REMOTE_TRANSPORTPARAM_AVAILABLE, (transportParams: TransportParameters) => {
            this.setRemoteTransportParameters(transportParams);
        });
    }

    private hookStreamManagerEvents() {
        this.streamManager.on(StreamManagerEvents.INITIALIZED_STREAM, (stream: Stream) => {
            if (stream.getStreamID().compare(new Bignum(0)) !== 0) {
                this.emit(ConnectionEvent.STREAM, new QuicStream(this, stream));
            } else {
                this.handshakeHandler.setHandshakeStream(stream);
            }
        });
    }

    public getRemoteInfo(): RemoteInfo {
        return this.remoteInfo;
    }

    public getInitialDestConnectionID(): ConnectionID {
        return this.initialDestConnectionID;
    }

    public setInitialDestConnectionID(connectionID: ConnectionID): void {
        this.initialDestConnectionID = connectionID;
    }

    public getSrcConnectionID(): ConnectionID {
        return this.srcConnectionID;
    }

    public setSrcConnectionID(connectionID: ConnectionID) {
        this.srcConnectionID = connectionID;
    }

    public getDestConnectionID(): ConnectionID {
        return this.destConnectionID;
    }

    public setDestConnectionID(connectionID: ConnectionID) {
        this.destConnectionID = connectionID;
    }

    public getState(): ConnectionState {
        return this.state;
    }

    public setState(connectionState: ConnectionState) {
        this.state = connectionState;
    }

    public getEndpointType(): EndpointType {
        return this.endpointType;
    }

    public getQuicTLS(): QTLS {
        return this.qtls;
    }

    public getAEAD(): AEAD {
        return this.aead;
    }

    public getAckHandler(): AckHandler {
        return this.ackHandler;
    }

    public getLossDetection(): LossDetection {
        return this.lossDetection;
    }

    public getStreamManager(): StreamManager {
        return this.streamManager;
    }

    public getLocalTransportParameter(type: TransportParameterType): any {
        return this.localTransportParameters.getTransportParameter(type);
    }

    public setLocalTransportParameter(type: TransportParameterType, value: any): void {
        this.localTransportParameters.setTransportParameter(type, value);
    }

    public getLocalTransportParameters(): TransportParameters {
        return this.localTransportParameters;
    }

    public getRemoteMaxStreamUni(): Bignum {
        return this.remoteMaxStreamUni;
    }

    public getRemoteMaxStreamBidi(): Bignum {
        return this.remoteMaxStreamBidi;
    }

    setRemoteMaxStreamUni(remoteMaxStreamUni: number): void
    setRemoteMaxStreamUni(remoteMaxStreamUni: Bignum): void
    public setRemoteMaxStreamUni(remoteMaxStreamUni: any): void {
        if (remoteMaxStreamUni instanceof Bignum) {
            this.remoteMaxStreamUni = remoteMaxStreamUni;
            return;
        }
        this.remoteMaxStreamUni = new Bignum(remoteMaxStreamUni);
    }

    setRemoteMaxStreamBidi(remoteMaxStreamBidi: number): void
    setRemoteMaxStreamBidi(remoteMaxStreamBidi: Bignum): void
    public setRemoteMaxStreamBidi(remoteMaxStreamBidi: any): void {
        if (remoteMaxStreamBidi instanceof Bignum) {
            this.remoteMaxStreamBidi = remoteMaxStreamBidi;
            return;
        }
        this.remoteMaxStreamBidi = new Bignum(remoteMaxStreamBidi);
    }

    public getLocalMaxStreamUni(): Bignum {
        return this.localMaxStreamUni;
    }

    public getLocalMaxStreamBidi(): Bignum {
        return this.localMaxStreamBidi;
    }

    setLocalMaxStreamUni(localMaxStreamUni: number): void
    setLocalMaxStreamUni(localMaxStreamUni: Bignum): void
    public setLocalMaxStreamUni(localMaxStreamUni: any): void {
        if (localMaxStreamUni instanceof Bignum) {
            this.localMaxStreamUni = localMaxStreamUni;
            return;
        }
        this.localMaxStreamUni = new Bignum(localMaxStreamUni);
    }

    setLocalMaxStreamBidi(localMaxStreamBidi: number): void
    setLocalMaxStreamBidi(localMaxStreamBidi: Bignum): void
    public setLocalMaxStreamBidi(localMaxStreamBidi: any): void {
        if (localMaxStreamBidi instanceof Bignum) {
            this.localMaxStreamBidi = localMaxStreamBidi;
            return;
        }
        this.localMaxStreamBidi = new Bignum(localMaxStreamBidi);
    }

    public setLocalMaxStreamUniBlocked(blocked: boolean): void {
        this.localMaxStreamUniBlocked = blocked;
    }

    public setLocalMaxStreamBidiBlocked(blocked: boolean): void {
        this.localMaxStreamBidiBlocked = blocked;
    }

    public getLocalMaxStreamUniBlocked(): boolean {
        return this.localMaxStreamUniBlocked;
    }

    public getLocalMaxStreamBidiBlocked(): boolean {
        return this.localMaxStreamBidiBlocked;
    }

    public setLocalTransportParameters(transportParameters: TransportParameters): void {
        this.localTransportParameters = transportParameters;
        this.setLocalMaxData(transportParameters.getTransportParameter(TransportParameterType.MAX_DATA));
        this.setLocalMaxStreamUni(transportParameters.getTransportParameter(TransportParameterType.INITIAL_MAX_STREAM_ID_UNI));
        this.setLocalMaxStreamBidi(transportParameters.getTransportParameter(TransportParameterType.INITIAL_MAX_STREAM_ID_BIDI));
        this.getStreamManager().getStreams().forEach((stream: Stream) => {
            stream.setLocalMaxData(transportParameters.getTransportParameter(TransportParameterType.MAX_STREAM_DATA));
        });
        this.getStreamManager().setLocalMaxStreamData(transportParameters.getTransportParameter(TransportParameterType.MAX_STREAM_DATA));
    }

    public getRemoteTransportParameter(type: TransportParameterType): any {
        return this.remoteTransportParameters.getTransportParameter(type);
    }

    public setRemoteTransportParameter(type: TransportParameterType, value: any): void {
        this.remoteTransportParameters.setTransportParameter(type, value);
    }

    public getRemoteTransportParameters(wreckingball = false): TransportParameters {
        if (wreckingball){
            this.remoteTransportParameters.setTransportParameter(TransportParameterType.MAX_DATA, 
                4048 )
        }
        return this.remoteTransportParameters;
    }

    public setRemoteTransportParameters(transportParameters: TransportParameters): void {
        this.remoteTransportParameters = transportParameters;
        this.setRemoteMaxData(transportParameters.getTransportParameter(TransportParameterType.MAX_DATA));
        this.setRemoteMaxStreamUni(transportParameters.getTransportParameter(TransportParameterType.INITIAL_MAX_STREAM_ID_UNI));
        this.setRemoteMaxStreamBidi(transportParameters.getTransportParameter(TransportParameterType.INITIAL_MAX_STREAM_ID_BIDI));
        this.getStreamManager().getStreams().forEach((stream: Stream) => {
            stream.setRemoteMaxData(transportParameters.getTransportParameter(TransportParameterType.MAX_STREAM_DATA));
        });
        this.getStreamManager().setRemoteMaxStreamData(transportParameters.getTransportParameter(TransportParameterType.MAX_STREAM_DATA));
    }

    public getSocket(): Socket {
        return this.socket;
    }

    public getLocalPacketNumber(): PacketNumber {
        return this.localPacketNumber;
    }

    public setLocalPacketNumber(packetNumber: PacketNumber) {
        this.localPacketNumber = packetNumber;
    }

    public getNextPacketNumber(): PacketNumber {
        if (this.localPacketNumber === undefined) {
            this.localPacketNumber = PacketNumber.randomPacketNumber();
            this.initialPacketNumber = this.localPacketNumber;
            return this.localPacketNumber;
        }
        var bn = this.localPacketNumber.getPacketNumber().add(1);
        this.localPacketNumber.setPacketNumber(bn);
        return this.localPacketNumber;
    }

    public getRemotePacketNumber(): PacketNumber {
        return this.remotePacketNumber;
    }

    public setRemotePacketNumber(packetNumber: PacketNumber) {
        this.remotePacketNumber = packetNumber;
    }

    public getVersion(): Version {
        return this.version;
    }

    public setVersion(version: Version): void {
        this.version = version;
    }

    public getSpinBit(): boolean {
        return this.spinBit;
    }

    public setSpinBit(spinbit: boolean): void {
        this.spinBit = spinbit;
    }

    public setSocket(socket: Socket): void {
        this.socket = socket;
    }

    public resetConnectionState() {
        this.remotePacketNumber = new PacketNumber(new Bignum(0).toBuffer());
        this.resetOffsets();
        this.getStreamManager().getStreams().forEach((stream: Stream) => {
            stream.reset();
        });
        this.lossDetection.reset();
    }

    public queueFrame(baseFrame: BaseFrame) {
        this.flowControl.queueFrame(baseFrame);
    }

    public queueFrames(baseFrames: BaseFrame[]): void {
        baseFrames.forEach((baseFrame: BaseFrame) => {
            this.flowControl.queueFrame(baseFrame);
        })
        if (!this.transmissionAlarm.isRunning()) {
            this.startTransmissionAlarm();
        }
    }

    private retransmitPacket(packet: BasePacket) {
        switch (packet.getPacketType()) {
            case PacketType.Initial:
                if (this.getStreamManager().getStream(0).getLocalOffset().greaterThan(0)) {
                    // Server hello is already received, packet does not need to be retransmitted
                    return;
                }
                break;
            case PacketType.Handshake:
                if (this.qtls.getHandshakeState() === HandshakeState.COMPLETED) {
                    // Only true for client after receiving the last stream 0 packet 
                    //      (with handshake data) in a protected short header packet
                    // Only true for server after receiving the last handshake packet of the client; 
                    //      after this packet everything needs to be send in shortheader packet
                    return;
                }
                break;
        }

        var framePacket = <BaseEncryptedPacket>packet;
        framePacket.getFrames().forEach((frame: BaseFrame) => {
            if (frame.isRetransmittable()) {
                this.retransmitFrame(frame);
            }
        });
        // Send packets
        this.sendPackets();
    }

    private retransmitFrame(frame: BaseFrame) {
        switch (frame.getType()) {
            case FrameType.MAX_STREAM_ID:
                var streamID = (<MaxStreamIdFrame>frame).getMaxStreamId();
                // Check if not a bigger maxStreamID frame has been sent
                if (Stream.isUniStreamId(streamID) && this.localMaxStreamUni.greaterThan(streamID)) {
                    return;
                }
                if (Stream.isBidiStreamId(streamID) && this.localMaxStreamBidi.greaterThan(streamID)) {
                    return;
                }
                break;
            case FrameType.MAX_STREAM_DATA:
                // Check if not a bigger MaxStreamData frame has been sent
                var maxStreamDataFrame = <MaxStreamFrame>frame;
                if (!this.getStreamManager().hasStream(maxStreamDataFrame.getStreamId())) {
                    return;
                }
                var stream = this.getStreamManager().getStream(maxStreamDataFrame.getStreamId());
                if (stream.getLocalMaxData().greaterThan(maxStreamDataFrame.getMaxData())) {
                    return;
                }
                break;
            case FrameType.MAX_DATA:
                // Check if not a bigger MaxData frame has been sent
                var maxDataFrame = <MaxDataFrame>frame;
                if (this.getLocalMaxData().greaterThan(maxDataFrame.getMaxData())) {
                    return;
                }
                break;
            case FrameType.STOP_SENDING:
                break;
            default:
                if (frame.getType() >= FrameType.STREAM) {
                    var streamFrame = <StreamFrame>frame;
                    // Check if stream exists and if RST_STREAM has been sent
                    // TODO: first check if RST_STREAM has been acked
                    // TODO: don't retransmit frame, retransmit data
                    if (!this.getStreamManager().hasStream(streamFrame.getStreamID())) {
                        return;
                    }
                    var stream = this.getStreamManager().getStream(streamFrame.getStreamID());
                    if (stream.getStreamState() === StreamState.LocalClosed || stream.getStreamState() === StreamState.Closed) {
                        return;
                    }
                    break;
                }
        }
        this.queueFrame(frame);
    }

    /**
     * Method to send a packet
     * @param basePacket packet to send
     */
    public sendPacket(basePacket: BasePacket, bufferPacket: boolean = true): void {
        if (basePacket.getPacketType() !== PacketType.Retry && basePacket.getPacketType() !== PacketType.VersionNegotiation && basePacket.getPacketType() !== PacketType.Initial && bufferPacket) {
            var baseEncryptedPacket: BaseEncryptedPacket = <BaseEncryptedPacket>basePacket;
            this.queueFrames(baseEncryptedPacket.getFrames());
        } else {
            this._sendPacket(basePacket);
        }
    }

    public sendPackets(): void {
        this.transmissionAlarm.reset();
        var ackBuffered: boolean = this.flowControl.isAckBuffered();
        if (!ackBuffered && (this.state === ConnectionState.Handshake || this.state === ConnectionState.Open)) {
            var ackFrame = this.ackHandler.getAckFrame(this);
            if (ackFrame !== undefined) {
                this.flowControl.queueFrame(ackFrame);
            }
        }
        var packets: BasePacket[] = this.flowControl.getPackets();
        packets.forEach((packet: BasePacket, index: number) => {
            this._sendPacket(packet);
        });
    }

    private _sendPacket(basePacket: BasePacket): void {
        if (this.connectionIsClosing()) {
            return;
        }
        if (basePacket !== undefined) {
            basePacket.getHeader().setPacketNumber(this.getNextPacketNumber());
            PacketLogging.getInstance().logOutgoingPacket(this, basePacket);
            this.emit(ConnectionEvent.PACKET_SENT, basePacket);
            this.getSocket().send(basePacket.toBuffer(this), this.getRemoteInfo().port, this.getRemoteInfo().address);
        }
    }

    private addPossibleAckFrame(baseFrames: BaseFrame[]) {
        var ackFrame = this.ackHandler.getAckFrame(this);
        if (ackFrame !== undefined) {
            baseFrames.push(ackFrame);
        }
        return baseFrames;
    }

    private startTransmissionAlarm(): void {
        this.transmissionAlarm.on(AlarmEvent.TIMEOUT, () => {
            this.sendPackets();
        });
        this.transmissionAlarm.start(40);
    }

    public attemptEarlyData(earlyData?: Buffer): boolean {
        if (earlyData !== undefined) {
            this.earlyData = earlyData;
        }
        if (this.earlyData !== undefined && this.getQuicTLS().isEarlyDataAllowed()) {
            var stream = this.getStreamManager().getNextStream(StreamType.ClientBidi);
            stream.addData(this.earlyData, true);
            this.sendPackets();
        }
        return false;
    }

    public startConnection(): void {
        if (this.endpointType === EndpointType.Server) {
            throw new QuicError(ConnectionErrorCodes.INTERNAL_ERROR);
        }
        this.handshakeHandler.startHandshake();
        this.sendPackets();
        this.startIdleAlarm();
    }


    public getClosePacket(): BaseEncryptedPacket {
        return this.closePacket;
    }

    public setClosePacket(packet: BaseEncryptedPacket): void {
        this.closePacket = packet;
    }

    public closeRequested() {
        var alarm = new Alarm();
        alarm.start(Constants.TEMPORARY_DRAINING_TIME);
        alarm.on(AlarmEvent.TIMEOUT, () => {
            this.emit(ConnectionEvent.CLOSE);
        });
    }

    public checkConnectionState(): void {
        if (this.connectionIsClosing()) {
            /**
             * Check to limit the amount of packets with closeframe inside
             */
            if (this.closeSentCount < Constants.MAXIMUM_CLOSE_FRAME_SEND && this.getState() !== ConnectionState.Draining) {
                this.closeSentCount++;
                var closePacket = this.getClosePacket();
                closePacket.getHeader().setPacketNumber(this.getNextPacketNumber());
                PacketLogging.getInstance().logOutgoingPacket(this, closePacket);
                this.getSocket().send(closePacket.toBuffer(this), this.getRemoteInfo().port, this.getRemoteInfo().address);
            }
            throw new QuickerError(QuickerErrorCodes.IGNORE_PACKET_ERROR);
        }
    }

    private connectionIsClosing(): boolean {
        if (this.getState() === ConnectionState.Closing) {
            return true;
        }
        if (this.getState() === ConnectionState.Draining) {
            return true;
        }
        return false;
    }

    public resetIdleAlarm(): void {
        this.idleTimeoutAlarm.reset();
    }
    public startIdleAlarm(): void {
        var time = this.localTransportParameters === undefined ? Constants.DEFAULT_IDLE_TIMEOUT : this.getLocalTransportParameter(TransportParameterType.IDLE_TIMEOUT);
        this.idleTimeoutAlarm.on(AlarmEvent.TIMEOUT, () => {
            this.state = ConnectionState.Draining;
            this.closeRequested();
            this.emit(ConnectionEvent.DRAINING);
        })
        this.idleTimeoutAlarm.start(time * 1000);
    }
}

export interface RemoteInformation {
    address: string;
    port: number,
    family: string
}

export enum ConnectionState {
    Handshake,
    Open,
    Closing,
    Draining,
    Closed
}

export enum ConnectionEvent {
    HANDSHAKE_DONE = "con-handshake-done",
    STREAM = "con-stream",
    DRAINING = "con-draining",
    CLOSE = "con-close",
    PACKET_SENT = "con-packet-sent"
}
import { useState, useEffect, useRef, useCallback } from 'react';
import { UdpSocket } from 'capacitor-udp-socket';
import { Capacitor } from '@capacitor/core';
import { Network } from '@capacitor/network';
import { saveChunk, getFileChunks, clearFileChunks } from '../utils/db';

const CHUNK_SIZE = 64 * 1024; // 64KB
const UDP_PORT = 3002;

export interface Peer {
  id: string;
  name: string;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  isDirect?: boolean;
  targetId?: string;
}

export interface FileTransfer {
  id: string;
  senderId: string;
  name: string;
  size: number;
  type: string;
  receivedBytes: number;
  status: 'pending' | 'transferring' | 'completed' | 'failed';
  speed?: number; // bytes per second
}

export function useWebRTC(userName: string, roomName: string) {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [transfers, setTransfers] = useState<Record<string, FileTransfer>>({});
  const [logs, setLogs] = useState<{time: string, msg: string}[]>([]);
  
  const addLog = useCallback((msg: string) => {
    setLogs(prev => [...prev.slice(-49), { time: new Date().toLocaleTimeString(), msg }]);
  }, []);
  
  const myIdRef = useRef<string>(Math.random().toString(36).substring(2, 9));
  const socketIdRef = useRef<number | null>(null);
  const broadcastAddrsRef = useRef<string[]>(['255.255.255.255', '192.168.43.255']);
  const [isConnected, setIsConnected] = useState<boolean>(true);
  
  const peersRef = useRef<Map<string, Peer>>(new Map());
  const connectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const channelsRef = useRef<Map<string, RTCDataChannel>>(new Map());
  const iceQueues = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  
  const receivingFileRef = useRef<Record<string, {
    metadata: { type: string, fileId: string, name: string, size: number, fileType: string };
    receivedBytes: number;
    chunkIndex: number;
    lastTime: number;
    lastBytes: number;
  }>>({});
  
  const sendingFileRef = useRef<Record<string, { lastTime: number, lastBytes: number }>>({});

  useEffect(() => {
    if (!userName || !roomName) return;

    if (!Capacitor.isNativePlatform()) {
      alert("This hardcore offline mode requires a native mobile device (Android/iOS) to broadcast UDP. It will not work in a desktop web browser.");
      return;
    }

    let heartbeatInterval: any;

    const setupUdp = async () => {
      try {
        try {
          await UdpSocket.closeAllSockets();
          addLog("Cleaned up existing sockets.");
        } catch (e) {}

        const { socketId } = await UdpSocket.create();
        socketIdRef.current = socketId;
        
        let currentPort = UDP_PORT;
        try {
          await UdpSocket.bind({ socketId, port: currentPort, address: '0.0.0.0' });
        } catch (bindErr) {
          addLog(`Port ${currentPort} bind failed, trying random fallback...`);
          currentPort = Math.floor(Math.random() * (5000 - 4000 + 1)) + 4000;
          await UdpSocket.bind({ socketId, port: currentPort, address: '0.0.0.0' });
          addLog(`Successfully bound to fallback port ${currentPort}`);
        }
        
        await UdpSocket.setBroadcast({ socketId, enabled: true });
        
        // Dynamically find local subnet broadcast
        try {
          const info = await UdpSocket.getInfo({ socketId });
          addLog(`Local IP Detection: ${info.localAddress || 'Unknown'}`);
          if (info.localAddress && info.localAddress !== '0.0.0.0' && info.localAddress !== '127.0.0.1') {
            const parts = info.localAddress.split('.');
            if (parts.length === 4) {
              const dynamicBcast = `${parts[0]}.${parts[1]}.${parts[2]}.255`;
              broadcastAddrsRef.current = [...new Set([dynamicBcast, '255.255.255.255', '192.168.43.255', '192.168.49.255', '192.168.4.255'])];
              addLog(`Smart Broadcast Address: ${dynamicBcast}`);
            }
          }
        } catch (e: any) {
           addLog(`Error getting local IP: ${e.message}`);
           console.error("Could not get socket info", e);
        }

        // Listen for UDP packets
        UdpSocket.addListener('receive', async (event) => {
          if (event.socketId !== socketIdRef.current || !event.buffer) return;
          
          try {
            // Buffer is base64 string from capacitor plugin or raw string?
            // Usually capacitor strings are raw unless specified. Assuming JSON directly.
            // If the plugin sends base64, we'd need to decode it. Let's assume raw string or we catch and decode.
            let payloadStr = event.buffer;
            const decodedStr = decodeURIComponent(escape(atob(payloadStr)));
            const data = JSON.parse(decodedStr);

            if (data.room !== roomName) return; // Ignore other rooms
            if (data.from === myIdRef.current) return; // Ignore self
            
            const fromId = data.from;

            if (data.type === 'discover') {
              if (!peersRef.current.has(fromId)) {
                addLog(`Packet Received (Discover): Found peer ${data.name} at ${event.remoteAddress || 'Unknown'}`);
                console.log('Discovered new peer:', data.name);
                peersRef.current.set(fromId, { id: fromId, name: data.name });
                updatePeers();
                
                // If I am the existing peer (my ID is "older" or just lexicographically smaller to avoid dual-initiation)
                // Actually, let's have the one who discovers initiate, but only if they haven't connected yet.
                // To avoid glare, peer with smaller ID initiates.
                if (myIdRef.current < fromId) {
                  await createPeerConnection(fromId, true);
                }
              }
            } else if (data.type === 'signal') {
              // Only process signals meant for me
              if (data.to !== myIdRef.current) return;
              
              const signal = data.signal;
              let pc = connectionsRef.current.get(fromId);
              if (!pc) {
                pc = await createPeerConnection(fromId, false);
              }

              if (signal.type === 'offer') {
                await pc.setRemoteDescription(new RTCSessionDescription(signal));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                sendUdpSignal(fromId, answer);
                
                // Process queued candidates
                const queue = iceQueues.current.get(fromId) || [];
                for (const candidate of queue) {
                  await pc.addIceCandidate(new RTCIceCandidate(candidate));
                }
                iceQueues.current.delete(fromId);
              } else if (signal.type === 'answer') {
                await pc.setRemoteDescription(new RTCSessionDescription(signal));
              } else if (signal.candidate) {
                if (pc.remoteDescription) {
                  await pc.addIceCandidate(new RTCIceCandidate(signal));
                } else {
                  const queue = iceQueues.current.get(fromId) || [];
                  queue.push(signal);
                  iceQueues.current.set(fromId, queue);
                }
              }
            }
          } catch (e) {
            // Ignore parse errors (might be non-JSON UDP traffic)
          }
        });

        // Start heartbeat
        const broadcastDiscover = async () => {
          if (!socketIdRef.current) return;
          const msg = JSON.stringify({
            type: 'discover',
            room: roomName,
            from: myIdRef.current,
            name: userName
          });
          // capacitor-udp-socket expects string buffer. Send as base64.
          const b64Msg = btoa(unescape(encodeURIComponent(msg)));
          try {
            addLog(`Packet Sent (Discover) to: ${broadcastAddrsRef.current.join(', ')}`);
            for (const addr of broadcastAddrsRef.current) {
              UdpSocket.send({
                socketId: socketIdRef.current,
                address: addr,
                port: UDP_PORT,
                buffer: b64Msg
              }).catch((e) => { addLog(`UDP Send Error to ${addr}: ${e.message}`); }); 
            }
          } catch (e: any) {
            addLog(`UDP Broadcast Try/Catch Error: ${e.message}`);
            console.error("Broadcast failed", e);
          }
        };

        broadcastDiscover();
        heartbeatInterval = setInterval(broadcastDiscover, 5000); // 5 seconds per request

      } catch (err: any) {
        let errDetails = "Unknown Error";
        try {
          errDetails = JSON.stringify(err);
        } catch (e) {
          errDetails = String(err);
        }
        addLog(`UDP Setup Error: ${err.message || ''} | ${errDetails}`);
        console.error("Failed to setup UDP", err);
      }
    };

    setupUdp();

    // Check Network status
    Network.getStatus().then(status => setIsConnected(status.connected));
    const netListener = Network.addListener('networkStatusChange', status => {
      setIsConnected(status.connected);
    });

    return () => {
      netListener.then(l => l.remove());
      clearInterval(heartbeatInterval);
      if (socketIdRef.current !== null) {
        UdpSocket.close({ socketId: socketIdRef.current });
      }
      connectionsRef.current.forEach(pc => pc.close());
      connectionsRef.current.clear();
      channelsRef.current.clear();
      peersRef.current.clear();
    };
  }, [userName, roomName]);

  const updatePeers = () => {
    setPeers(Array.from(peersRef.current.values()));
  };

  const sendUdpSignal = async (toId: string, signalData: any) => {
    if (!socketIdRef.current) return;
    const msg = JSON.stringify({
      type: 'signal',
      room: roomName,
      from: myIdRef.current,
      to: toId,
      signal: signalData
    });
    const b64Msg = btoa(unescape(encodeURIComponent(msg)));
    try {
      for (const addr of broadcastAddrsRef.current) {
        UdpSocket.send({
          socketId: socketIdRef.current,
          address: addr,
          port: UDP_PORT,
          buffer: b64Msg
        }).catch(() => {});
      }
    } catch (e) {
      console.error("Signal broadcast failed", e);
    }
  };

  const createPeerConnection = async (peerId: string, initiator: boolean) => {
    // No ICE servers needed for local subnet, but including standard ones won't hurt
    const pc = new RTCPeerConnection({
      iceServers: [] // Hardcore offline mode
    });
    
    connectionsRef.current.set(peerId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendUdpSignal(peerId, event.candidate);
      }
    };
    
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        peersRef.current.delete(peerId);
        updatePeers();
        channelsRef.current.delete(peerId);
        connectionsRef.current.delete(peerId);
      }
    };

    if (initiator) {
      const channel = pc.createDataChannel('data');
      setupDataChannel(peerId, channel);
      
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendUdpSignal(peerId, pc.localDescription);
    } else {
      pc.ondatachannel = (event) => {
        setupDataChannel(peerId, event.channel);
      };
    }

    return pc;
  };

  const setupDataChannel = (peerId: string, channel: RTCDataChannel) => {
    channel.binaryType = 'arraybuffer';
    channelsRef.current.set(peerId, channel);

    channel.onopen = () => console.log(`Data channel open with ${peerId}`);
    channel.onclose = () => console.log(`Data channel closed with ${peerId}`);

    channel.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data);
        
        if (msg.type === 'chat') {
          setMessages(prev => [...prev, {
            id: msg.id,
            senderId: peerId,
            senderName: peersRef.current.get(peerId)?.name || 'Unknown',
            text: msg.text,
            timestamp: msg.timestamp,
            isDirect: msg.isDirect
          }]);
        } else if (msg.type === 'file-start') {
          const transferId = msg.fileId;
          setTransfers(prev => ({
            ...prev,
            [transferId]: {
              id: transferId,
              senderId: peerId,
              name: msg.name,
              size: msg.size,
              type: msg.fileType,
              receivedBytes: 0,
              status: 'pending'
            }
          }));
          receivingFileRef.current[transferId] = {
            metadata: msg,
            receivedBytes: 0,
            chunkIndex: 0,
            lastTime: Date.now(),
            lastBytes: 0
          };
          
          channel.send(JSON.stringify({ type: 'file-accept', fileId: transferId }));
        }
      } else if (event.data instanceof ArrayBuffer) {
        const data = event.data;
        const fileIdBytes = data.slice(0, 36);
        const fileId = new TextDecoder().decode(fileIdBytes);
        const chunkData = data.slice(36);
        
        const fileState = receivingFileRef.current[fileId];
        if (fileState) {
          await saveChunk(fileId, chunkData, fileState.chunkIndex);
          fileState.chunkIndex++;
          fileState.receivedBytes += chunkData.byteLength;
          
          const now = Date.now();
          let currentSpeed = 0;
          if (now - fileState.lastTime >= 500) {
            currentSpeed = ((fileState.receivedBytes - fileState.lastBytes) / (now - fileState.lastTime)) * 1000;
            fileState.lastTime = now;
            fileState.lastBytes = fileState.receivedBytes;
          }
          
          setTransfers(prev => {
            const update = { ...prev };
            if (update[fileId]) {
              update[fileId] = { ...update[fileId], receivedBytes: fileState.receivedBytes, status: 'transferring' };
              if (currentSpeed > 0) update[fileId].speed = currentSpeed;
            }
            return update;
          });

          if (fileState.receivedBytes >= fileState.metadata.size) {
            setTransfers(prev => ({
              ...prev,
              [fileId]: { ...prev[fileId], status: 'completed' }
            }));
            
            const chunks = await getFileChunks(fileId);
            const blob = new Blob(chunks, { type: fileState.metadata.fileType });
            const url = URL.createObjectURL(blob);
            
            const a = document.createElement('a');
            a.href = url;
            a.download = fileState.metadata.name;
            a.click();
            URL.revokeObjectURL(url);
            
            await clearFileChunks(fileId);
            delete receivingFileRef.current[fileId];
          }
        }
      }
    };
  };

  const sendChatMessage = useCallback((text: string, targetPeerId: string | null = null) => {
    const msg = {
      type: 'chat',
      id: Math.random().toString(36).substring(2, 9),
      text,
      timestamp: Date.now(),
      isDirect: !!targetPeerId
    };
    
    setMessages(prev => [...prev, {
      id: msg.id,
      senderId: 'me',
      senderName: userName,
      text,
      timestamp: msg.timestamp,
      isDirect: msg.isDirect,
      targetId: targetPeerId || undefined
    }]);

    if (targetPeerId) {
      const channel = channelsRef.current.get(targetPeerId);
      if (channel && channel.readyState === 'open') {
        channel.send(JSON.stringify(msg));
      }
    } else {
      channelsRef.current.forEach(channel => {
        if (channel.readyState === 'open') {
          channel.send(JSON.stringify(msg));
        }
      });
    }
  }, [userName]);

  const sendFile = useCallback(async (file: File, targetPeerId: string | null = null) => {
    const fileId = Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
    
    const paddedFileId = fileId.padEnd(36, ' ');
    const fileIdEncoder = new TextEncoder();
    const fileIdPrefix = fileIdEncoder.encode(paddedFileId);

    const metadata = {
      type: 'file-start',
      fileId: paddedFileId,
      name: file.name,
      size: file.size,
      fileType: file.type
    };

    if (targetPeerId) {
      const channel = channelsRef.current.get(targetPeerId);
      if (channel && channel.readyState === 'open') {
        channel.send(JSON.stringify(metadata));
      }
    } else {
      channelsRef.current.forEach(channel => {
        if (channel.readyState === 'open') {
          channel.send(JSON.stringify(metadata));
        }
      });
    }
    
    setTransfers(prev => ({
      ...prev,
      [paddedFileId]: {
        id: paddedFileId,
        senderId: 'me',
        name: file.name,
        size: file.size,
        type: file.type,
        receivedBytes: 0,
        status: 'transferring',
        speed: 0
      }
    }));
    
    sendingFileRef.current[paddedFileId] = { lastTime: Date.now(), lastBytes: 0 };

    const reader = new FileReader();
    let offset = 0;
    
    const readSlice = (o: number) => {
      const slice = file.slice(o, o + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    reader.onload = async (e) => {
      const buffer = e.target?.result as ArrayBuffer;
      if (!buffer) return;

      const combined = new Uint8Array(fileIdPrefix.byteLength + buffer.byteLength);
      combined.set(fileIdPrefix, 0);
      combined.set(new Uint8Array(buffer), fileIdPrefix.byteLength);

      if (targetPeerId) {
        const channel = channelsRef.current.get(targetPeerId);
        if (channel && channel.readyState === 'open') {
          channel.send(combined.buffer);
        }
      } else {
        channelsRef.current.forEach(channel => {
          if (channel.readyState === 'open') {
            channel.send(combined.buffer);
          }
        });
      }
      
      offset += buffer.byteLength;
      
      const now = Date.now();
      const state = sendingFileRef.current[paddedFileId];
      let currentSpeed = 0;
      if (state && now - state.lastTime >= 500) {
        currentSpeed = ((offset - state.lastBytes) / (now - state.lastTime)) * 1000;
        state.lastTime = now;
        state.lastBytes = offset;
      }
      
      setTransfers(prev => {
        const update = { ...prev };
        if (update[paddedFileId]) {
          update[paddedFileId] = { ...update[paddedFileId], receivedBytes: offset };
          if (currentSpeed > 0) update[paddedFileId].speed = currentSpeed;
        }
        return update;
      });

      if (offset < file.size) {
        setTimeout(() => readSlice(offset), 0);
      } else {
        setTransfers(prev => ({
          ...prev,
          [paddedFileId]: { ...prev[paddedFileId], status: 'completed' }
        }));
      }
    };

    readSlice(0);
  }, []);

  return { peers, messages, transfers, sendChatMessage, sendFile, isConnected, logs };
}

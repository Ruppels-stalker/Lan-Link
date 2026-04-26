import { useState, useEffect, useRef, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { Network } from '@capacitor/network';
import { saveChunk, getFileChunks, clearFileChunks } from '../utils/db';

const CHUNK_SIZE = 64 * 1024; // 64KB

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
  const [isConnected, setIsConnected] = useState<boolean>(true);
  const peerIpsRef = useRef<Map<string, string>>(new Map());
  
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

    const setupDiscovery = async () => {
      addLog(`Platform: ${Capacitor.getPlatform()}`);
      addLog(`HTTP Server started on port 3003 (Java)`);

      const netStatus = await Network.getStatus();
      if (netStatus.connectionType === 'none' || netStatus.connectionType === 'cellular') {
        addLog(`WARNING: Connection type is ${netStatus.connectionType}. discovery may fail without Wi-Fi.`);
      }

      // Listen for HTTP signals from Java Server
      window.addEventListener('http-signal', ((event: any) => {
        try {
          const payloadStr = typeof event.detail === 'string' ? JSON.parse(event.detail).payload : event.detail.payload;
          const data = JSON.parse(payloadStr);
          processSignal(data);
        } catch (e) {
          console.error("Failed to parse HTTP signal", e);
        }
      }) as any);

      // Listen for Native NSD Registration
      window.addEventListener('nsd-registered', ((event: any) => {
        try {
          const payloadStr = typeof event.detail === 'string' ? event.detail : JSON.stringify(event.detail);
          const data = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr;
          myIdRef.current = data.name;
          addLog(`NSD Registered as: ${data.name}`);
        } catch (e) {
          console.error("Failed to parse nsd-registered", e);
        }
      }) as any);

      // Listen for Native NSD Peer Discovery
      window.addEventListener('nsd-peer-resolved', ((event: any) => {
        try {
          const payloadStr = typeof event.detail === 'string' ? event.detail : JSON.stringify(event.detail);
          const data = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr;
          
          const id = data.name;
          const name = id; // use the NSD name as peer name for simplicity
          const ip = data.ip;

          if (id && id !== myIdRef.current) {
            if (!peersRef.current.has(id)) {
              addLog(`NSD: Found peer ${name} at ${ip}:${data.port}`);
              peersRef.current.set(id, { id, name });
              peerIpsRef.current.set(id, ip);
              updatePeers();
              
              if (myIdRef.current < id) {
                createPeerConnection(id, true);
              }
            }
          }
        } catch (e) {
          console.error("Failed to parse nsd-peer-resolved", e);
        }
      }) as any);
      
      addLog("Native NSD Listeners activated.");
    };

    const processSignal = async (data: any) => {
      if (data.room !== roomName) return;
      if (data.from === myIdRef.current) return;
      if (data.to !== myIdRef.current) return;

      const fromId = data.from;
      const signal = data.signal;

      let pc = connectionsRef.current.get(fromId);
      if (!pc) {
        pc = await createPeerConnection(fromId, false);
      }

      if (signal.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(fromId, answer);
        
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
    };

    setupDiscovery();

    // Check Network status
    Network.getStatus().then(status => setIsConnected(status.connected));
    const netListener = Network.addListener('networkStatusChange', status => {
      setIsConnected(status.connected);
    });

    return () => {
      netListener.then(l => l.remove());
      connectionsRef.current.forEach(pc => pc.close());
      connectionsRef.current.clear();
      channelsRef.current.clear();
      peersRef.current.clear();
    };
  }, [userName, roomName]);

  const updatePeers = () => {
    setPeers(Array.from(peersRef.current.values()));
  };

  const sendSignal = async (toId: string, signalData: any) => {
    const peerIp = peerIpsRef.current.get(toId);
    if (!peerIp) {
      addLog(`Error: Cannot send signal to ${toId}, IP unknown.`);
      return;
    }

    const msg = JSON.stringify({
      type: 'signal',
      room: roomName,
      from: myIdRef.current,
      to: toId,
      signal: signalData
    });

    const attemptFetch = async (retries = 3): Promise<void> => {
      try {
        const fetchUrl = `http://${peerIp}:3003/signal`;
        console.log(`[Signal Verification] Fetching URL: ${fetchUrl}`);
        console.log(`[Signal Verification] Headers: Content-Type: application/x-www-form-urlencoded`);
        
        const response = await fetch(fetchUrl, {
          method: 'POST',
          mode: 'cors',
          cache: 'no-store',
          credentials: 'omit',
          body: `postData=${encodeURIComponent(msg)}`,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (e: any) {
        if (retries > 0) {
          addLog(`Signaling Error to ${peerIp}: ${e.message}. Retrying in 3s...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
          return attemptFetch(retries - 1);
        } else {
          addLog(`Signaling Error to ${peerIp}: ${e.message}. Max retries reached.`);
        }
      }
    };

    await attemptFetch();
  };

  const createPeerConnection = async (peerId: string, initiator: boolean) => {
    // No ICE servers needed for local subnet, but including standard ones won't hurt
    const pc = new RTCPeerConnection({
      iceServers: [] // Hardcore offline mode
    });
    
    connectionsRef.current.set(peerId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(peerId, event.candidate);
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
      sendSignal(peerId, pc.localDescription);
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

  const connectToIp = async (ip: string) => {
    addLog(`Direct HTTP Connect initiated to: ${ip}`);
    
    const manualPeerId = 'manual-' + Math.random().toString(36).substring(2, 9);
    peersRef.current.set(manualPeerId, { id: manualPeerId, name: ip });
    peerIpsRef.current.set(manualPeerId, ip);
    updatePeers();

    await createPeerConnection(manualPeerId, true);
  };

  return { peers, messages, transfers, sendChatMessage, sendFile, isConnected, logs, connectToIp };
}

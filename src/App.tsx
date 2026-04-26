import { useState, useRef, useEffect } from 'react';
import { Send, FileUp, Users, Wifi, HardDrive, Download, Zap, Lock, Globe, WifiOff, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useWebRTC } from './hooks/useWebRTC';
import { generateFunnyName } from './utils/nameGenerator';
import './App.css';

export default function App() {
  const [inRoom, setInRoom] = useState(false);
  const [userName, setUserName] = useState('');
  const [roomName, setRoomName] = useState('local-hub');

  useEffect(() => {
    setUserName(generateFunnyName());
  }, []);

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (userName.trim() && roomName.trim()) {
      setInRoom(true);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 font-sans selection:bg-indigo-500/30 flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-950/50 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-indigo-500 p-2 rounded-lg">
              <Zap size={20} className="text-white" />
            </div>
            <h1 className="font-bold text-xl tracking-tight">LanLink</h1>
          </div>
          {inRoom && (
            <div className="flex items-center gap-4 text-sm font-medium text-slate-400">
              <span className="flex items-center gap-2">
                <Wifi size={16} className="text-emerald-400" />
                {roomName}
              </span>
              <div className="h-4 w-px bg-slate-800"></div>
              <span>{userName}</span>
            </div>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col">
        <AnimatePresence mode="wait">
          {!inRoom ? (
            <motion.div
              key="login"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="flex-1 flex items-center justify-center p-4"
            >
              <div className="w-full max-w-md space-y-8 bg-slate-900 border border-slate-800 p-8 rounded-2xl shadow-2xl">
                <div className="text-center space-y-2">
                  <h2 className="text-3xl font-bold tracking-tight">Join Network</h2>
                  <p className="text-slate-400">Zero-config LAN file transfer & chat</p>
                </div>

                <form onSubmit={handleJoin} className="space-y-6">
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-slate-300">Your Peer Name</label>
                      <input
                        type="text"
                        value={userName}
                        onChange={(e) => setUserName(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-shadow"
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-slate-300">Room ID</label>
                      <input
                        type="text"
                        value={roomName}
                        onChange={(e) => setRoomName(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-shadow font-mono text-lg tracking-widest text-center"
                        required
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="w-full bg-indigo-500 hover:bg-indigo-600 text-white font-semibold py-3 rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    Enter Room
                  </button>
                </form>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="room"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex-1 flex flex-col md:flex-row h-[calc(100vh-4rem)] max-w-6xl mx-auto w-full"
            >
              <Room userName={userName} roomName={roomName} />
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

function Room({ userName, roomName }: { userName: string; roomName: string }) {
  const { peers, messages, transfers, sendChatMessage, sendFile, isConnected, logs, connectToIp } = useWebRTC(userName, roomName);
  const [manualIp, setManualIp] = useState('');
  const [msgInput, setMsgInput] = useState('');
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const loggerEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, transfers]);

  useEffect(() => {
    loggerEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const handleSendMsg = (e: React.FormEvent) => {
    e.preventDefault();
    if (msgInput.trim()) {
      sendChatMessage(msgInput, selectedPeerId);
      setMsgInput('');
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      sendFile(e.target.files[0], selectedPeerId);
      e.target.value = ''; // Reset input
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <>
      {/* Sidebar: Peers */}
      <div className="w-full md:w-64 border-r border-slate-800 bg-slate-900/30 p-4 flex flex-col gap-4">
        <div className="flex items-center gap-2 text-slate-400 font-medium mb-2">
          <Users size={18} />
          <h3>Active Peers ({peers.length})</h3>
        </div>
        <div className="flex-1 overflow-y-auto space-y-2 p-1">
          {!isConnected && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-2 text-red-400 text-sm mb-4">
              <WifiOff size={18} className="shrink-0" />
              <span className="font-medium">No Wi-Fi/Hotspot Connection</span>
            </motion.div>
          )}
          <AnimatePresence>
            <motion.div
              onClick={() => setSelectedPeerId(null)}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${!selectedPeerId ? 'bg-indigo-500/20 border-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.1)]' : 'bg-slate-800/30 border-slate-700/30 hover:bg-slate-800/60 hover:border-slate-600/50 shadow-sm'}`}
            >
              <div className="w-9 h-9 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-bold text-xs shadow-inner">
                <Globe size={18} className="text-slate-300" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">Everyone</p>
              </div>
            </motion.div>
            
            {peers.length === 0 && isConnected && (
              <motion.div initial={{opacity:0}} animate={{opacity:1}} className="flex items-center gap-3 p-4 rounded-xl border border-slate-800/50 bg-slate-900/20 mt-4">
                <div className="relative flex items-center justify-center w-8 h-8">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-20 animate-ping"></span>
                  <Loader2 size={18} className="text-indigo-400 animate-spin" />
                </div>
                <span className="text-sm text-slate-400 font-medium tracking-wide">Scanning for peers...</span>
              </motion.div>
            )}
            {peers.map(peer => (
              <motion.div
                key={peer.id}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setSelectedPeerId(peer.id)}
                className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${selectedPeerId === peer.id ? 'bg-indigo-500/20 border-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.1)]' : 'bg-slate-800/30 border-slate-700/30 hover:bg-slate-800/60 hover:border-slate-600/50 shadow-sm'}`}
              >
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center font-bold text-sm shadow-md border border-indigo-400/30 text-white">
                  {peer.name.charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{peer.name}</p>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* Plan B: Direct Connect */}
        <div className="mt-2 border-t border-slate-800/50 pt-4 flex flex-col gap-2">
           <h4 className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Plan B: Direct Connect</h4>
           <div className="flex gap-2">
             <input 
               type="text" 
               id="direct-connect-ip"
               placeholder="192.168.x.x" 
               value={manualIp} 
               onChange={e => setManualIp(e.target.value)} 
               className="w-full bg-slate-950/50 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-indigo-500" 
             />
             <button 
               type="button"
               onClick={() => {
                 if (manualIp.trim()) { 
                   connectToIp(manualIp.trim()); 
                   setManualIp(''); 
                 } 
               }}
               disabled={!manualIp.trim()} 
               className="bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white rounded-lg px-3 text-xs font-medium transition-colors"
             >
               Add
             </button>
           </div>
        </div>
      </div>

      {/* Main Chat/Transfer Area */}
      <div className="flex-1 flex flex-col bg-slate-950">
        <div className="flex-1 p-4 overflow-y-auto space-y-6">
          
          {/* File Transfers */}
          {Object.values(transfers).length > 0 && (
            <div className="space-y-3 mb-8">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-2">
                <HardDrive size={14} /> Active Transfers
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {Object.values(transfers).map(t => {
                  const progress = t.size > 0 ? (t.receivedBytes / t.size) * 100 : 0;
                  return (
                    <motion.div
                      key={t.id}
                      layout
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col gap-3"
                    >
                      <div className="flex justify-between items-start">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={`p-2 rounded-lg ${t.status === 'completed' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-indigo-500/20 text-indigo-400'}`}>
                            {t.status === 'completed' ? <Download size={20} /> : <FileUp size={20} />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium truncate text-slate-200" title={t.name}>{t.name}</p>
                            <p className="text-xs text-slate-400 flex items-center flex-wrap gap-1.5 mt-1">
                              <span>{formatBytes(t.receivedBytes)} / {formatBytes(t.size)}</span>
                              {t.speed && t.status === 'transferring' && (
                                <>
                                  <span className="w-1 h-1 rounded-full bg-slate-700"></span>
                                  <span className="text-indigo-400 font-medium">{formatBytes(t.speed)}/s</span>
                                </>
                              )}
                              <span className="w-1 h-1 rounded-full bg-slate-700"></span>
                              <span className="font-medium text-slate-300">{Math.round(progress)}%</span>
                            </p>
                          </div>
                        </div>
                        <span className="text-xs font-medium px-2 py-1 rounded-full bg-slate-800 text-slate-300 capitalize">
                          {t.status}
                        </span>
                      </div>
                      
                      {/* Progress Bar */}
                      <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                        <motion.div
                          className={`h-full ${t.status === 'completed' ? 'bg-emerald-500' : 'bg-indigo-500'}`}
                          initial={{ width: 0 }}
                          animate={{ width: `${progress}%` }}
                          transition={{ type: 'tween', ease: 'linear', duration: 0.2 }}
                        />
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Chat Messages */}
          <div className="space-y-4">
            {messages.map((msg) => {
              const isMe = msg.senderId === 'me';
              return (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex flex-col max-w-[75%] ${isMe ? 'ml-auto items-end' : 'mr-auto items-start'}`}
                >
                  {!isMe && (
                    <span className="text-xs text-slate-400 mb-1 ml-1 flex items-center gap-1">
                      {msg.senderName}
                      {msg.isDirect && <span className="text-indigo-400 flex items-center gap-1 ml-1"><Lock size={10} /> Direct</span>}
                    </span>
                  )}
                  {isMe && msg.isDirect && (
                    <span className="text-xs text-slate-400 mb-1 mr-1 flex items-center gap-1 justify-end">
                      To: {peers.find(p => p.id === msg.targetId)?.name || 'Unknown'} <Lock size={10} />
                    </span>
                  )}
                  <div className={`px-4 py-2.5 rounded-2xl text-sm ${isMe ? 'bg-indigo-600 text-white rounded-br-none' : 'bg-slate-800 text-slate-100 rounded-bl-none'}`}>
                    {msg.text}
                  </div>
                </motion.div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input Area & Debugger */}
        <div className="p-4 bg-slate-900/50 border-t border-slate-800 flex flex-col gap-4">
          <form onSubmit={handleSendMsg} className="flex gap-2">
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              onChange={handleFileChange}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="p-3 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-xl transition-colors shrink-0"
              title="Send File"
            >
              <FileUp size={22} />
            </button>
            <input
              type="text"
              value={msgInput}
              onChange={(e) => setMsgInput(e.target.value)}
              placeholder={`Type a message to ${selectedPeerId ? peers.find(p => p.id === selectedPeerId)?.name || 'Unknown' : 'Everyone'}...`}
              className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button
              type="submit"
              disabled={!msgInput.trim()}
              className="p-3 bg-indigo-500 hover:bg-indigo-600 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-xl transition-colors shrink-0"
            >
              <Send size={20} className={msgInput.trim() ? "translate-x-0.5" : ""} />
            </button>
          </form>

          {/* Debug Logger */}
          <div className="h-28 bg-[#0a0a0a] border border-slate-800 rounded-lg p-3 overflow-y-auto font-mono text-[11px] leading-relaxed text-emerald-400/90 shadow-inner">
            <div className="text-slate-500/80 mb-2 border-b border-slate-800 pb-1 flex justify-between">
              <span>-- UDP Debug Logger --</span>
              <span>{logs.length} events</span>
            </div>
            {logs.map((log, i) => (
              <div key={i} className="break-all">
                <span className="text-slate-600 mr-2">[{log.time}]</span> 
                {log.msg}
              </div>
            ))}
            <div ref={loggerEndRef} />
          </div>
        </div>
      </div>
    </>
  );
}

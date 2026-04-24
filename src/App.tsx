import React, { useState, useEffect, useRef, useCallback } from "react";
import { Mic, MicOff, Loader2, Volume2, VolumeX, Keyboard, Send, Trash2, LogIn, LogOut, User as UserIcon, Pause, Play } from "lucide-react";
import { getZoyaResponse, getZoyaAudio, resetZoyaSession, startZoyaResearch } from "./services/geminiService";
import { processCommand } from "./services/commandService";
import { LiveSessionManager } from "./services/liveService";
import Visualizer from "./components/Visualizer";
import PermissionModal from "./components/PermissionModal";
import { playPCM } from "./utils/audioUtils";
import { motion, AnimatePresence } from "motion/react";
import { auth, db, signInWithGoogle, handleFirestoreError } from "./lib/firebase";
import { onAuthStateChanged, signOut, User } from "firebase/auth";
import { 
  collection, 
  query, 
  orderBy, 
  limit, 
  onSnapshot, 
  addDoc, 
  serverTimestamp, 
  deleteDoc, 
  getDocs,
  doc,
  setDoc,
  getDoc
} from "firebase/firestore";
import { Search, BrainCircuit } from "lucide-react";

type AppState = "idle" | "listening" | "processing" | "speaking" | "researching";

interface ChatMessage {
  id: string;
  sender: "user" | "zoya";
  text: string;
}

declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [appState, setAppState] = useState<AppState>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef(messages);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Auth State Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        // Update profile
        try {
          const userDoc = doc(db, "users", currentUser.uid);
          await setDoc(userDoc, {
            displayName: currentUser.displayName || "User",
            email: currentUser.email,
            lastLogin: serverTimestamp()
          }, { merge: true });
        } catch (error) {
          console.error("Error updating profile:", error);
        }
      } else {
        setMessages([]);
      }
    });
    return () => unsubscribe();
  }, []);

  // Firestore Messages Listener
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, "users", user.uid, "messages"),
      orderBy("createdAt", "asc"),
      limit(50)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgs: ChatMessage[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        msgs.push({
          id: doc.id,
          sender: data.sender,
          text: data.text
        });
      });
      setMessages(msgs);
    }, (error) => {
      handleFirestoreError(error, "list", `users/${user.uid}/messages`);
    });

    return () => unsubscribe();
  }, [user]);

  const saveMessage = async (sender: "user" | "zoya", text: string) => {
    if (!user) return;
    try {
      await addDoc(collection(db, "users", user.uid, "messages"), {
        sender,
        text,
        createdAt: serverTimestamp()
      });
    } catch (error) {
      handleFirestoreError(error, "create", `users/${user.uid}/messages`);
    }
  };

  const [isMuted, setIsMuted] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    if (liveSessionRef.current) {
      liveSessionRef.current.isMuted = isMuted;
    }
  }, [isMuted]);

  const togglePause = async () => {
    if (liveSessionRef.current) {
      const newState = await liveSessionRef.current.togglePause();
      setIsPaused(!!newState);
    }
  };

  const [showTextInput, setShowTextInput] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [researchTopic, setResearchTopic] = useState("");
  const [isResearchMode, setIsResearchMode] = useState(false);
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  const [isSessionActive, setIsSessionActive] = useState(false);

  const liveSessionRef = useRef<LiveSessionManager | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, appState]);

  const handleTextCommand = useCallback(async (finalTranscript: string) => {
    if (!finalTranscript.trim()) {
      setAppState("idle");
      return;
    }

    if (user) {
      saveMessage("user", finalTranscript);
    } else {
      setMessages((prev) => [...prev, { id: Date.now().toString(), sender: "user", text: finalTranscript }]);
    }
    
    // If live session is active, send text through it
    if (isSessionActive && liveSessionRef.current) {
      liveSessionRef.current.sendText(finalTranscript);
      return;
    }

    setAppState("processing");

    // 1. Check for browser commands
    const commandResult = processCommand(finalTranscript);

    let responseText = "";

    if (commandResult.isBrowserAction) {
      responseText = commandResult.action;
      if (user) {
        saveMessage("zoya", responseText);
      } else {
        setMessages((prev) => [...prev, { id: Date.now().toString() + "-z", sender: "zoya", text: responseText }]);
      }
      
      if (!isMuted) {
        setAppState("speaking");
        const audioBase64 = await getZoyaAudio(responseText);
        if (audioBase64) {
          await playPCM(audioBase64);
        }
      }

      setAppState("idle");

      setTimeout(() => {
        if (commandResult.url) {
          window.open(commandResult.url, "_blank");
        }
      }, 1500);
    } else {
      // 2. General Chit-Chat via Gemini
      responseText = await getZoyaResponse(finalTranscript, messagesRef.current, user?.displayName || "Dharmendra Singh");
      if (user) {
        saveMessage("zoya", responseText);
      } else {
        setMessages((prev) => [...prev, { id: Date.now().toString() + "-z", sender: "zoya", text: responseText }]);
      }
      
      if (!isMuted) {
        setAppState("speaking");
        const audioBase64 = await getZoyaAudio(responseText);
        if (audioBase64) {
          await playPCM(audioBase64);
        }
      }
      setAppState("idle");
    }
  }, [isMuted, isSessionActive]);

  useEffect(() => {
    return () => {
      if (liveSessionRef.current) {
        liveSessionRef.current.stop();
      }
    };
  }, []);

  const toggleListening = async () => {
    if (isSessionActive) {
      setIsSessionActive(false);
      setIsPaused(false);
      if (liveSessionRef.current) {
        liveSessionRef.current.stop();
        liveSessionRef.current = null;
      }
      setAppState("idle");
      resetZoyaSession();
    } else {
      try {
        setIsSessionActive(true);
        resetZoyaSession();
        
        const session = new LiveSessionManager(user?.displayName || "Dharmendra Singh");
        session.isMuted = isMuted;
        liveSessionRef.current = session;
        
        session.onStateChange = (state) => {
          setAppState(state);
        };
        
        session.onMessage = (sender, text) => {
          if (user) {
            saveMessage(sender, text);
          } else {
            setMessages((prev) => [...prev, { id: Date.now().toString() + "-" + sender, sender, text }]);
          }
        };
        
        session.onCommand = (url) => {
          setTimeout(() => {
            window.open(url, "_blank");
          }, 1000);
        };

        await session.start();
      } catch (e: any) {
        console.error("Failed to start session", e);
        const errorMsg = e.message || e.toString();
        if (errorMsg.includes("Permission denied") || errorMsg.includes("NotAllowedError")) {
          setShowPermissionModal(true);
        } else {
          alert(`Ugh, Zoya is being dramatic: ${errorMsg}`);
        }
        setIsSessionActive(false);
        setAppState("idle");
      }
    }
  };

  const handleResearch = async () => {
    if (!researchTopic.trim()) return;
    
    const topic = researchTopic;
    setResearchTopic("");
    setIsResearchMode(false);
    setAppState("researching");
    
    if (user) {
      saveMessage("user", `Deep Research Request: ${topic}`);
    } else {
      setMessages((prev) => [...prev, { id: Date.now().toString(), sender: "user", text: `Deep Research Request: ${topic}` }]);
    }

    let fullResponse = "";
    const msgId = Date.now().toString() + "-research";
    
    // Add an initial empty message from Zoya that we will update
    if (!user) {
      setMessages((prev) => [...prev, { id: msgId, sender: "zoya", text: "Starting deep research..." }]);
    }

    try {
      await startZoyaResearch(topic, (delta) => {
        fullResponse += delta;
        if (user) {
          // In a real app we might debounce firestore updates or wait for final
          // but for the demo we'll just keep it in state if not logged in 
          // and save it once at the end if logged in to save on writes.
        }
        setMessages((prev) => {
          const newMessages = [...prev];
          const index = newMessages.findIndex(m => m.id === msgId);
          if (index !== -1) {
            newMessages[index].text = fullResponse;
          } else if (!user) {
             newMessages.push({ id: msgId, sender: "zoya", text: fullResponse });
          }
          return newMessages;
        });
      });
      
      if (user) {
        await saveMessage("zoya", fullResponse);
      }
      
      setAppState("idle");
    } catch (error) {
      console.error("Research Error:", error);
      const errorMessage = "Ugh, my research servers are being dramatic. Try again later.";
      if (user) {
        saveMessage("zoya", errorMessage);
      } else {
        setMessages((prev) => [...prev, { id: Date.now().toString(), sender: "zoya", text: errorMessage }]);
      }
      setAppState("idle");
    }
  };

  const handleTextSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isResearchMode) {
      handleResearch();
    } else {
      if (!textInput.trim()) return;
      handleTextCommand(textInput);
      setTextInput("");
      setShowTextInput(false);
    }
  };

  return (
    <div className="h-[100dvh] w-screen bg-[#050505] text-white flex flex-col items-center justify-between font-sans relative overflow-hidden m-0 p-0">
      {showPermissionModal && (
        <PermissionModal 
          onClose={() => setShowPermissionModal(false)} 
        />
      )}

      {/* Cinematic Background Gradients */}
      <div className="absolute inset-0 w-full h-full overflow-hidden pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-violet-900/20 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] bg-pink-900/20 blur-[120px] rounded-full" />
      </div>

      {/* Header */}
      <header className="absolute top-0 left-0 w-full flex justify-between items-center z-20 shrink-0 px-6 py-4 md:px-12 md:py-6">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-violet-500 to-pink-500 flex items-center justify-center font-bold text-sm">
            Z
          </div>
          <h1 className="text-xl font-serif font-medium tracking-wide opacity-90">Zoya</h1>
        </div>
        <div className="flex items-center gap-2">
          {user ? (
            <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-full pl-1 pr-3 py-1 mr-2">
              <img src={user.photoURL || ""} alt={user.displayName || ""} className="w-6 h-6 rounded-full" />
              <span className="text-xs font-medium opacity-70 hidden md:block">{user.displayName}</span>
              <button 
                onClick={() => signOut(auth)}
                className="ml-2 hover:text-red-400 transition-colors"
                title="Sign Out"
              >
                <LogOut size={14} />
              </button>
            </div>
          ) : (
            <button 
              onClick={() => signInWithGoogle()}
              className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-violet-600 hover:bg-violet-700 text-sm font-medium transition-colors mr-2"
            >
              <LogIn size={16} />
              <span className="hidden md:inline">Sign In</span>
            </button>
          )}

          {messages.length > 0 && (
            <button
              onClick={async () => {
                if (confirm("Are you sure you want to clear the chat history?")) {
                  if (user) {
                    const q = query(collection(db, "users", user.uid, "messages"));
                    const snapshot = await getDocs(q);
                    const deletePromises = snapshot.docs.map(doc => deleteDoc(doc.ref));
                    await Promise.all(deletePromises);
                  } else {
                    setMessages([]);
                  }
                  resetZoyaSession();
                }
              }}
              className="p-2 rounded-full bg-white/5 hover:bg-red-500/20 hover:text-red-400 transition-colors border border-white/10"
              title="Clear Chat History"
            >
              <Trash2 size={18} className="opacity-70" />
            </button>
          )}

          {isSessionActive && (
            <button
              onClick={togglePause}
              className={`p-2 rounded-full transition-colors border ${
                isPaused 
                  ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/50" 
                  : "bg-white/5 border-white/10 hover:bg-white/10"
              }`}
              title={isPaused ? "Resume" : "Pause"}
            >
              {isPaused ? <Play size={18} /> : <Pause size={18} />}
            </button>
          )}

          <button
            onClick={() => setIsMuted(!isMuted)}
            className="p-2 rounded-full bg-white/5 hover:bg-white/10 transition-colors border border-white/10"
            title={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted ? (
              <VolumeX size={18} className="opacity-70" />
            ) : (
              <Volume2 size={18} className="opacity-70" />
            )}
          </button>
        </div>
      </header>

      {/* Main Content - Visualizer & Chat */}
      <main className="absolute inset-0 flex flex-row items-center justify-between w-full h-full z-10 overflow-hidden pt-20 pb-24 px-4 md:px-12 pointer-events-none">
        
        {/* Left Column: Zoya Status */}
        <div className="flex w-[30%] lg:w-[25%] h-full flex-col justify-center gap-4 z-10">
          <div className="h-6">
            <AnimatePresence>
              {(appState === "processing" || appState === "researching") && (
                <motion.div
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="flex items-center gap-2 text-cyan-300/80 text-sm md:text-base italic font-serif"
                >
                  <Loader2 size={16} className="animate-spin" />
                  {appState === "researching" ? "Searching deep... (Zoya is thinking hard)" : "Replying..."}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Center Visualizer (Fixed Full Screen Background) */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-0">
          <Visualizer state={appState} />
        </div>

        {/* Right Column: User Status */}
        <div className="flex w-[30%] lg:w-[25%] h-full flex-col justify-center gap-4 z-10">
          <div className="h-6 flex justify-end">
            <AnimatePresence>
              {appState === "listening" && (
                <motion.div
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  className="flex items-center gap-2 text-violet-300/80 text-sm md:text-base italic"
                >
                  <div className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
                  Listening...
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

      </main>

      {/* Controls */}
      <footer className="absolute bottom-0 left-0 w-full flex flex-col items-center justify-center pb-6 md:pb-8 z-20 shrink-0 gap-4">
        <AnimatePresence>
          {showTextInput && (
            <motion.form 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              onSubmit={handleTextSubmit}
              className="w-full max-w-md flex items-center gap-2 bg-white/5 border border-white/10 rounded-full p-1 pl-4 backdrop-blur-md shadow-2xl"
            >
              <input 
                type="text"
                value={isResearchMode ? researchTopic : textInput}
                onChange={(e) => isResearchMode ? setResearchTopic(e.target.value) : setTextInput(e.target.value)}
                placeholder={isResearchMode ? "What should I research deeply?" : "Type a message to Zoya..."}
                className="flex-1 bg-transparent border-none outline-none text-white placeholder:text-white/30 text-sm"
                autoFocus
                onBlur={() => {
                  if (isResearchMode && !researchTopic.trim()) {
                    setIsResearchMode(false);
                    setShowTextInput(false);
                  }
                }}
              />
              <button 
                type="submit"
                disabled={isResearchMode ? !researchTopic.trim() : !textInput.trim()}
                className={`p-2 rounded-full transition-colors ${
                  isResearchMode ? "bg-cyan-500 hover:bg-cyan-600" : "bg-violet-500 hover:bg-violet-600"
                } disabled:opacity-50`}
              >
                {isResearchMode ? <Search size={16} /> : <Send size={16} />}
              </button>
            </motion.form>
          )}
        </AnimatePresence>

        <div className="flex items-center gap-4">
          <button
            onClick={() => {
              setIsResearchMode(true);
              setShowTextInput(true);
            }}
            className={`p-4 rounded-full transition-all duration-300 shadow-2xl border ${
              isResearchMode 
                ? "bg-cyan-500/20 text-cyan-400 border-cyan-500/50" 
                : "bg-white/5 border-white/10 hover:bg-white/10 text-white/70"
            }`}
            title="Deep Research Mode"
          >
            <BrainCircuit size={20} />
          </button>

          <button
            onClick={toggleListening}
            className={`
              group relative flex items-center gap-3 px-8 py-4 rounded-full font-medium tracking-wide transition-all duration-300 shadow-2xl
              ${
                isSessionActive
                  ? "bg-red-500/20 text-red-400 border border-red-500/50 hover:bg-red-500/30"
                  : "bg-white/10 text-white border border-white/20 hover:bg-white/20 hover:scale-105"
              }
            `}
          >
            {isSessionActive ? (
              <>
                <MicOff size={20} />
                <span>End Session</span>
              </>
            ) : (
              <>
                <Mic size={20} className="group-hover:animate-bounce" />
                <span>Start Session</span>
              </>
            )}
          </button>
          
          {!isSessionActive && (
            <button
              onClick={() => setShowTextInput(!showTextInput)}
              className="p-4 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 transition-colors shadow-2xl"
              title="Type instead"
            >
              <Keyboard size={20} className="opacity-70" />
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

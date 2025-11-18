const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 3001;
const rooms = new Map(); // roomId -> { host:{socket,loadout}, guest:{socket,loadout} }

const server = new WebSocketServer({ port: PORT }, ()=>{
  console.log(`[online-server] listening on ws://localhost:${PORT}`);
});

server.on("connection", (socket)=>{
  socket.on("message", (data)=> handleMessage(socket, data));
  socket.on("close", ()=> handleDisconnect(socket));
});

function handleMessage(socket, data){
  let payload;
  try{
    payload = JSON.parse(data.toString());
  }catch{
    return;
  }
  switch(payload.type){
    case "create_room":
      return createRoom(socket, payload);
    case "join_room":
      return joinRoom(socket, payload);
    case "player_move":
      return relayMove(socket, payload);
    case "leave_room":
      return leaveRoom(socket);
    default:
      socket.send(JSON.stringify({ type:"room_error", message:"Unknown message type." }));
  }
}

function createRoom(socket, payload){
  const roomId = generateRoomId();
  socket.roomId = roomId;
  socket.role = "host";
  rooms.set(roomId, {
    host: { socket, loadout: payload.loadout||[] },
    guest: null
  });
  socket.send(JSON.stringify({ type:"room_created", roomId }));
}

function joinRoom(socket, payload){
  const roomId = (payload.roomId||"").toUpperCase();
  const room = rooms.get(roomId);
  if(!room){
    socket.send(JSON.stringify({ type:"room_error", message:"Room not found." }));
    return;
  }
  if(room.guest){
    socket.send(JSON.stringify({ type:"room_error", message:"Room is full." }));
    return;
  }
  socket.roomId = roomId;
  socket.role = "guest";
  room.guest = { socket, loadout: payload.loadout||[] };
  socket.send(JSON.stringify({ type:"room_joined", roomId }));
  room.host.socket.send(JSON.stringify({ type:"guest_joined" }));
  startMatch(roomId);
}

function startMatch(roomId){
  const room = rooms.get(roomId);
  if(!room || !room.host || !room.guest) return;
  const payload = {
    type: "start_game",
    roomId,
    hostLoadout: room.host.loadout || [],
    guestLoadout: room.guest.loadout || [],
    first: "host"
  };
  room.host.socket.send(JSON.stringify(payload));
  room.guest.socket.send(JSON.stringify(payload));
}

function relayMove(socket, payload){
  const roomId = socket.roomId;
  if(!roomId) return;
  const room = rooms.get(roomId);
  if(!room) return;
  const target = socket.role === "host" ? room.guest : room.host;
  if(!target || !target.socket) return;
  target.socket.send(JSON.stringify({
    type: "opponent_move",
    stoneId: payload.stoneId,
    x: payload.x,
    y: payload.y
  }));
}

function leaveRoom(socket){
  const roomId = socket.roomId;
  if(!roomId) return;
  const room = rooms.get(roomId);
  if(!room) return;
  const target = socket.role === "host" ? room.guest : room.host;
  if(target && target.socket && target.socket.readyState === WebSocket.OPEN){
    target.socket.send(JSON.stringify({ type:"opponent_left" }));
    target.socket.roomId = null;
    target.socket.role = null;
  }
  rooms.delete(roomId);
  socket.roomId = null;
  socket.role = null;
}

function handleDisconnect(socket){
  leaveRoom(socket);
}

function generateRoomId(){
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id;
  do{
    id = Array.from({length:6}, ()=> chars[Math.floor(Math.random()*chars.length)]).join("");
  }while(rooms.has(id));
  return id;
}

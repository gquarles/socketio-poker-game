const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DEFAULT_STARTING_STACK = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const NEXT_HAND_DELAY_MS = 5000;
const MAX_LOGS = 40;
const FULL_DECK_SIZE = 52;
const HAND_NAMES = [
  "High Card",
  "One Pair",
  "Two Pair",
  "Three of a Kind",
  "Straight",
  "Flush",
  "Full House",
  "Four of a Kind",
  "Straight Flush",
];

const state = {
  players: [],
  startingStack: DEFAULT_STARTING_STACK,
  smallBlind: SMALL_BLIND,
  bigBlind: BIG_BLIND,
  gameStarted: false,
  handInProgress: false,
  handNumber: 0,
  phase: "lobby",
  deck: [],
  burnCards: [],
  seenCards: new Set(),
  communityCards: [],
  pot: 0,
  currentBet: 0,
  lastRaiseSize: BIG_BLIND,
  currentTurnId: null,
  dealerId: null,
  smallBlindId: null,
  bigBlindId: null,
  logs: [],
  lastShowdown: null,
  nextHandTimer: null,
};

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  socket.emit("state", buildStateFor(socket.id));

  socket.on("join", (payload = {}) => {
    if (findPlayer(socket.id)) {
      socket.emit("errorMessage", "You are already seated.");
      return;
    }
    if (state.gameStarted) {
      socket.emit("errorMessage", "Game already started. Wait for the next game.");
      return;
    }

    const name = sanitizeName(payload.name);
    if (!name) {
      socket.emit("errorMessage", "Enter a valid name (2-20 characters).");
      return;
    }

    state.players.push(createPlayer(socket.id, name));
    assignAdminIfNeeded();
    addLog(`${name} joined the lobby.`);
    emitStateToAll();
  });

  socket.on("setStartingStack", (payload = {}) => {
    const player = findPlayer(socket.id);
    if (!player || !player.isAdmin) {
      socket.emit("errorMessage", "Only the admin can set starting money.");
      return;
    }
    if (state.gameStarted) {
      socket.emit("errorMessage", "Cannot change starting money after game start.");
      return;
    }

    const amount = Number(payload.amount);
    if (!Number.isInteger(amount) || amount < 50 || amount > 1000000) {
      socket.emit("errorMessage", "Starting money must be an integer between 50 and 1,000,000.");
      return;
    }

    state.startingStack = amount;
    for (const seatedPlayer of state.players) {
      if (!seatedPlayer.disconnected) {
        seatedPlayer.chips = amount;
      }
    }
    addLog(`${player.name} set starting money to ${amount}.`);
    emitStateToAll();
  });

  socket.on("startGame", () => {
    const player = findPlayer(socket.id);
    if (!player || !player.isAdmin) {
      socket.emit("errorMessage", "Only the admin can start the game.");
      return;
    }
    if (state.gameStarted) {
      socket.emit("errorMessage", "Game is already running.");
      return;
    }

    cleanupDisconnectedPlayers();
    const connectedPlayers = getConnectedPlayers();
    if (connectedPlayers.length < 2) {
      socket.emit("errorMessage", "Need at least 2 players to start.");
      return;
    }

    for (const connectedPlayer of connectedPlayers) {
      connectedPlayer.chips = state.startingStack;
      resetPlayerHandState(connectedPlayer);
    }

    cancelNextHandTimer();
    state.gameStarted = true;
    state.handNumber = 0;
    state.dealerId = null;
    state.lastShowdown = null;
    addLog(`${player.name} started the game.`);
    startNextHand();
  });

  socket.on("action", (payload = {}) => {
    handleAction(socket.id, payload);
  });

  socket.on("disconnect", () => {
    handleDisconnect(socket.id);
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Poker server running at http://localhost:${PORT}`);
});

function createPlayer(id, name) {
  return {
    id,
    name,
    chips: state.startingStack,
    isAdmin: false,
    disconnected: false,
    inHand: false,
    folded: false,
    allIn: false,
    holeCards: [],
    betThisRound: 0,
    totalContribution: 0,
    acted: false,
  };
}

function sanitizeName(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length < 2 || trimmed.length > 20) {
    return "";
  }
  return trimmed;
}

function addLog(message) {
  const time = new Date().toLocaleTimeString();
  state.logs.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    at: time,
    text: message,
  });
  if (state.logs.length > MAX_LOGS) {
    state.logs = state.logs.slice(state.logs.length - MAX_LOGS);
  }
}

function emitStateToAll() {
  for (const [socketId, socket] of io.sockets.sockets) {
    socket.emit("state", buildStateFor(socketId));
  }
}

function buildStateFor(viewerId) {
  const viewer = findPlayer(viewerId);
  const shownPlayers = state.players.filter((player) => !player.disconnected);
  const availableActions = computeAvailableActions(viewer);

  return {
    joined: Boolean(viewer),
    youId: viewerId,
    gameStarted: state.gameStarted,
    handInProgress: state.handInProgress,
    handNumber: state.handNumber,
    phase: state.phase,
    startingStack: state.startingStack,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    pot: state.pot,
    currentBet: state.currentBet,
    deckRemaining: state.deck.length,
    burnCount: state.burnCards.length,
    dealtCount: state.seenCards.size,
    minRaiseTo: getMinRaiseTo(),
    dealerId: state.dealerId,
    smallBlindId: state.smallBlindId,
    bigBlindId: state.bigBlindId,
    currentTurnId: state.currentTurnId,
    communityCards: state.communityCards,
    yourCards: viewer && viewer.inHand ? viewer.holeCards : [],
    handInsight: buildHandInsight(viewer),
    availableActions,
    canAct: Boolean(viewer && state.currentTurnId === viewer.id && isPlayerActionable(viewer)),
    players: shownPlayers.map((player) => ({
      id: player.id,
      name: player.name,
      chips: player.chips,
      isAdmin: player.isAdmin,
      inHand: player.inHand,
      folded: player.folded,
      allIn: player.allIn,
      betThisRound: player.betThisRound,
      totalContribution: player.totalContribution,
      isTurn: player.id === state.currentTurnId,
    })),
    logs: state.logs,
    lastShowdown: state.lastShowdown,
  };
}

function buildHandInsight(player) {
  if (!player || !state.handInProgress || !player.inHand || player.folded || player.holeCards.length !== 2) {
    return null;
  }

  if (state.communityCards.length === 0) {
    const preflop = evaluatePreflopStrength(player.holeCards);
    return {
      currentHand: preflop.currentHand,
      strengthScore: preflop.strengthScore,
      strengthLabel: preflop.strengthLabel,
      draws: [],
      recommendation: preflop.recommendation,
    };
  }

  const knownCards = player.holeCards.concat(state.communityCards);
  const madeScore = evaluateBestKnownHand(knownCards);
  const draws = detectDraws(knownCards, madeScore);
  const score = scorePostflopStrength(madeScore, draws, state.communityCards.length);

  return {
    currentHand: describeScoreDetailed(madeScore),
    strengthScore: score,
    strengthLabel: strengthLabelFromScore(score),
    draws,
    recommendation: recommendationFromInsight(score, draws),
  };
}

function computeAvailableActions(player) {
  if (!player || !state.handInProgress || state.currentTurnId !== player.id || !isPlayerActionable(player)) {
    return {
      canFold: false,
      canCheck: false,
      canCall: false,
      canRaise: false,
      callAmount: 0,
      minRaiseTo: getMinRaiseTo(),
      maxRaiseTo: 0,
    };
  }

  const toCall = Math.max(0, state.currentBet - player.betThisRound);
  const maxTotal = player.betThisRound + player.chips;
  const minRaiseTo = getMinRaiseTo();
  const raiseRightsOpen = !player.acted || toCall === 0;
  const canRaise = raiseRightsOpen && player.chips > 0 && maxTotal > state.currentBet;
  const minRaiseTarget = maxTotal < minRaiseTo ? maxTotal : minRaiseTo;

  return {
    canFold: true,
    canCheck: toCall === 0,
    canCall: toCall > 0 && player.chips > 0,
    canRaise,
    callAmount: Math.min(toCall, player.chips),
    minRaiseTo: minRaiseTarget,
    maxRaiseTo: maxTotal,
  };
}

function findPlayer(playerId) {
  return state.players.find((player) => player.id === playerId) || null;
}

function getConnectedPlayers() {
  return state.players.filter((player) => !player.disconnected);
}

function assignAdminIfNeeded() {
  const connectedPlayers = getConnectedPlayers();
  const existingAdmin = connectedPlayers.find((player) => player.isAdmin);
  if (existingAdmin) {
    for (const player of state.players) {
      if (player.id !== existingAdmin.id) {
        player.isAdmin = false;
      }
    }
    return;
  }

  for (const player of state.players) {
    player.isAdmin = false;
  }
  if (connectedPlayers.length > 0) {
    connectedPlayers[0].isAdmin = true;
    addLog(`${connectedPlayers[0].name} is now admin.`);
  }
}

function cleanupDisconnectedPlayers() {
  state.players = state.players.filter((player) => !player.disconnected);
}

function cancelNextHandTimer() {
  if (state.nextHandTimer) {
    clearTimeout(state.nextHandTimer);
    state.nextHandTimer = null;
  }
}

function queueNextHand() {
  cancelNextHandTimer();
  state.nextHandTimer = setTimeout(() => {
    startNextHand();
  }, NEXT_HAND_DELAY_MS);
}

function startNextHand() {
  cleanupDisconnectedPlayers();
  assignAdminIfNeeded();

  const eligible = state.players.filter((player) => !player.disconnected && player.chips > 0);
  if (eligible.length < 2) {
    state.gameStarted = false;
    state.handInProgress = false;
    state.phase = "lobby";
    state.deck = [];
    state.burnCards = [];
    state.seenCards = new Set();
    state.currentTurnId = null;
    state.smallBlindId = null;
    state.bigBlindId = null;
    state.currentBet = 0;
    state.lastRaiseSize = state.bigBlind;
    cancelNextHandTimer();
    if (eligible.length === 1) {
      addLog(`${eligible[0].name} wins the game.`);
    } else {
      addLog("Game stopped: not enough players.");
    }
    emitStateToAll();
    return;
  }

  state.handInProgress = true;
  state.phase = "preflop";
  state.handNumber += 1;
  state.communityCards = [];
  state.pot = 0;
  state.currentBet = 0;
  state.lastRaiseSize = state.bigBlind;
  state.currentTurnId = null;
  state.smallBlindId = null;
  state.bigBlindId = null;
  state.lastShowdown = null;
  state.burnCards = [];
  state.seenCards = new Set();
  const freshDeck = createDeck();
  assertDeckShape(freshDeck);
  state.deck = shuffleDeck(freshDeck);
  assertDeckShape(state.deck);

  for (const player of state.players) {
    player.inHand = !player.disconnected && player.chips > 0;
    player.folded = !player.inHand;
    player.allIn = false;
    player.holeCards = [];
    player.betThisRound = 0;
    player.totalContribution = 0;
    player.acted = false;
  }

  if (!state.dealerId || !eligible.some((player) => player.id === state.dealerId)) {
    state.dealerId = eligible[0].id;
  } else {
    const nextDealer = getNextPlayer(state.dealerId, (player) => player.inHand);
    state.dealerId = nextDealer ? nextDealer.id : eligible[0].id;
  }

  for (let cardIndex = 0; cardIndex < 2; cardIndex += 1) {
    for (const player of state.players) {
      if (player.inHand) {
        player.holeCards.push(drawCard("dealing hole cards"));
      }
    }
  }

  const playersInHand = state.players.filter((player) => player.inHand);
  let smallBlindPlayer = null;
  let bigBlindPlayer = null;

  if (playersInHand.length === 2) {
    smallBlindPlayer = findPlayer(state.dealerId);
    bigBlindPlayer = getNextPlayer(state.dealerId, (player) => player.inHand);
  } else {
    smallBlindPlayer = getNextPlayer(state.dealerId, (player) => player.inHand);
    bigBlindPlayer = getNextPlayer(smallBlindPlayer ? smallBlindPlayer.id : state.dealerId, (player) => player.inHand);
  }

  if (!smallBlindPlayer || !bigBlindPlayer) {
    addLog("Unable to assign blinds.");
    resolveHandByFold();
    return;
  }

  state.smallBlindId = smallBlindPlayer.id;
  state.bigBlindId = bigBlindPlayer.id;

  postForcedBet(smallBlindPlayer, state.smallBlind, "small blind");
  postForcedBet(bigBlindPlayer, state.bigBlind, "big blind");
  // A short blind all-in does not reduce preflop call/raise sizing.
  state.currentBet = Math.max(state.bigBlind, smallBlindPlayer.betThisRound, bigBlindPlayer.betThisRound);
  state.lastRaiseSize = state.bigBlind;

  for (const player of state.players) {
    player.acted = !isPlayerActionable(player);
  }

  const firstToAct = getNextPlayer(state.bigBlindId, (player) => isPlayerActionable(player));
  state.currentTurnId = firstToAct ? firstToAct.id : null;

  addLog(`Hand #${state.handNumber} started. Dealer: ${findPlayer(state.dealerId).name}.`);

  if (!state.currentTurnId) {
    fastForwardBoardAndShowdown();
    return;
  }

  emitStateToAll();
}

function postForcedBet(player, amount, label) {
  const paid = Math.min(amount, player.chips);
  commitBet(player, paid);
  if (player.chips === 0) {
    player.allIn = true;
  }
  addLog(`${player.name} posts ${label} (${paid}).`);
}

function handleAction(playerId, action) {
  const player = findPlayer(playerId);
  if (!player) {
    return;
  }
  if (!state.gameStarted || !state.handInProgress) {
    sendError(playerId, "No active hand right now.");
    return;
  }
  if (state.currentTurnId !== playerId) {
    sendError(playerId, "It is not your turn.");
    return;
  }
  if (!isPlayerActionable(player)) {
    sendError(playerId, "You cannot act right now.");
    return;
  }

  const actionType = typeof action.type === "string" ? action.type.toLowerCase() : "";
  const toCall = Math.max(0, state.currentBet - player.betThisRound);

  if (actionType === "fold") {
    player.folded = true;
    player.inHand = false;
    player.acted = true;
    addLog(`${player.name} folds.`);
    advanceAfterAction(player.id);
    return;
  }

  if (actionType === "check") {
    if (toCall !== 0) {
      sendError(playerId, "You cannot check when facing a bet.");
      return;
    }
    player.acted = true;
    addLog(`${player.name} checks.`);
    advanceAfterAction(player.id);
    return;
  }

  if (actionType === "call") {
    if (toCall === 0) {
      sendError(playerId, "Nothing to call. Use check.");
      return;
    }
    const callAmount = Math.min(toCall, player.chips);
    commitBet(player, callAmount);
    player.acted = true;
    if (player.chips === 0) {
      player.allIn = true;
      addLog(`${player.name} calls all-in for ${callAmount}.`);
    } else {
      addLog(`${player.name} calls ${callAmount}.`);
    }
    advanceAfterAction(player.id);
    return;
  }

  if (actionType === "raise") {
    const targetTotal = Number(action.amount);
    const maxTotal = player.betThisRound + player.chips;
    const minRaiseTo = getMinRaiseTo();
    const raiseRightsOpen = !player.acted || toCall === 0;
    const previousBet = state.currentBet;
    const raiseSize = targetTotal - previousBet;
    const isAllInRaise = targetTotal === maxTotal;
    const isFullRaise = raiseSize >= state.lastRaiseSize;

    if (!Number.isInteger(targetTotal)) {
      sendError(playerId, "Raise amount must be an integer.");
      return;
    }
    if (!raiseRightsOpen) {
      sendError(playerId, "Betting is not reopened. You may only call or fold.");
      return;
    }
    if (targetTotal <= state.currentBet) {
      sendError(playerId, "Raise must be higher than current bet.");
      return;
    }
    if (targetTotal > maxTotal) {
      sendError(playerId, "You do not have enough chips for that raise.");
      return;
    }
    if (targetTotal < minRaiseTo && !isAllInRaise) {
      sendError(playerId, `Minimum raise is to ${minRaiseTo}, unless you are all-in.`);
      return;
    }

    const raiseAmount = targetTotal - player.betThisRound;
    commitBet(player, raiseAmount);

    state.currentBet = targetTotal;
    if (isFullRaise) {
      state.lastRaiseSize = raiseSize;
      for (const seatedPlayer of state.players) {
        seatedPlayer.acted = !isPlayerActionable(seatedPlayer);
      }
    }
    player.acted = true;
    if (player.chips === 0) {
      player.allIn = true;
    }

    addLog(`${player.name} raises to ${targetTotal}.`);
    advanceAfterAction(player.id);
    return;
  }

  sendError(playerId, "Invalid action.");
}

function advanceAfterAction(lastActorId) {
  if (!state.handInProgress) {
    return;
  }

  if (countRemainingInHand() <= 1) {
    resolveHandByFold();
    return;
  }

  if (isBettingRoundComplete()) {
    goToNextStreet();
    return;
  }

  const nextPlayer = getNextPlayer(lastActorId, (player) => isPlayerActionable(player));
  if (!nextPlayer) {
    goToNextStreet();
    return;
  }

  state.currentTurnId = nextPlayer.id;
  emitStateToAll();
}

function goToNextStreet() {
  if (!state.handInProgress) {
    return;
  }

  if (state.phase === "river") {
    resolveShowdown();
    return;
  }

  revealNextStreet();

  for (const player of state.players) {
    if (player.inHand) {
      player.betThisRound = 0;
      player.acted = !isPlayerActionable(player);
    }
  }

  state.currentBet = 0;
  state.lastRaiseSize = state.bigBlind;

  const firstToAct = getNextPlayer(state.dealerId, (player) => isPlayerActionable(player));
  state.currentTurnId = firstToAct ? firstToAct.id : null;

  if (!state.currentTurnId) {
    fastForwardBoardAndShowdown();
    return;
  }

  emitStateToAll();
}

function revealNextStreet() {
  if (state.phase === "preflop") {
    burnTopCard();
    state.phase = "flop";
    state.communityCards.push(drawCard("dealing flop"), drawCard("dealing flop"), drawCard("dealing flop"));
    addLog(`Flop: ${state.communityCards.join(" ")}`);
    return;
  }
  if (state.phase === "flop") {
    burnTopCard();
    state.phase = "turn";
    state.communityCards.push(drawCard("dealing turn"));
    addLog(`Turn: ${state.communityCards[state.communityCards.length - 1]}`);
    return;
  }
  if (state.phase === "turn") {
    burnTopCard();
    state.phase = "river";
    state.communityCards.push(drawCard("dealing river"));
    addLog(`River: ${state.communityCards[state.communityCards.length - 1]}`);
  }
}

function fastForwardBoardAndShowdown() {
  if (!state.handInProgress) {
    return;
  }
  if (countRemainingInHand() <= 1) {
    resolveHandByFold();
    return;
  }

  while (state.phase !== "river") {
    revealNextStreet();
  }
  resolveShowdown();
}

function resolveHandByFold() {
  const remainingPlayers = state.players.filter((player) => player.inHand && !player.folded);
  if (remainingPlayers.length !== 1) {
    resolveShowdown();
    return;
  }

  const winner = remainingPlayers[0];
  const winAmount = state.pot;
  winner.chips += winAmount;

  state.phase = "showdown";
  state.lastShowdown = {
    type: "fold",
    communityCards: [...state.communityCards],
    hands: [
      {
        id: winner.id,
        name: winner.name,
        cards: winner.holeCards,
        handName: "Won by fold",
      },
    ],
    payouts: [
      {
        id: winner.id,
        name: winner.name,
        amount: winAmount,
      },
    ],
  };

  addLog(`${winner.name} wins ${winAmount} (everyone else folded).`);
  finishHand();
}

function resolveShowdown() {
  const contenders = state.players.filter((player) => player.inHand && !player.folded);
  if (contenders.length === 0) {
    addLog("Hand ended with no contenders.");
    finishHand();
    return;
  }

  const scoreById = new Map();
  for (const contender of contenders) {
    const score = evaluateBestHand(contender.holeCards.concat(state.communityCards));
    scoreById.set(contender.id, score);
  }

  const payouts = calculatePayouts(scoreById);
  for (const [winnerId, amount] of payouts.entries()) {
    if (amount > 0) {
      const winner = findPlayer(winnerId);
      if (winner) {
        winner.chips += amount;
      }
    }
  }

  const payoutRows = [...payouts.entries()]
    .filter(([, amount]) => amount > 0)
    .map(([winnerId, amount]) => {
      const winner = findPlayer(winnerId);
      return {
        id: winnerId,
        name: winner ? winner.name : "Unknown",
        amount,
      };
    })
    .sort((a, b) => b.amount - a.amount);

  const handRows = contenders.map((contender) => {
    const score = scoreById.get(contender.id);
    return {
      id: contender.id,
      name: contender.name,
      cards: contender.holeCards,
      handName: describeScore(score),
    };
  });

  state.phase = "showdown";
  state.lastShowdown = {
    type: "showdown",
    communityCards: [...state.communityCards],
    hands: handRows,
    payouts: payoutRows,
  };

  if (payoutRows.length > 0) {
    addLog(
      payoutRows
        .map((entry) => `${entry.name} wins ${entry.amount}`)
        .join(" | "),
    );
  } else {
    addLog("Showdown ended with no payout.");
  }

  finishHand();
}

function calculatePayouts(scoreById) {
  const contributors = state.players.filter((player) => player.totalContribution > 0);
  const payoutMap = new Map();
  for (const player of state.players) {
    payoutMap.set(player.id, 0);
  }

  const levels = [...new Set(contributors.map((player) => player.totalContribution))].sort((a, b) => a - b);
  let previousLevel = 0;

  for (const level of levels) {
    const involved = contributors.filter((player) => player.totalContribution >= level);
    const sidePot = (level - previousLevel) * involved.length;
    previousLevel = level;
    if (sidePot <= 0) {
      continue;
    }

    const eligible = involved.filter((player) => scoreById.has(player.id));
    if (eligible.length === 0) {
      continue;
    }

    let bestScore = null;
    let winners = [];
    for (const player of eligible) {
      const score = scoreById.get(player.id);
      if (!bestScore || compareScores(score, bestScore) > 0) {
        bestScore = score;
        winners = [player];
      } else if (compareScores(score, bestScore) === 0) {
        winners.push(player);
      }
    }

    if (winners.length === 0) {
      continue;
    }

    const evenShare = Math.floor(sidePot / winners.length);
    let remainder = sidePot % winners.length;

    for (const winner of winners) {
      payoutMap.set(winner.id, payoutMap.get(winner.id) + evenShare);
    }

    if (remainder > 0) {
      const orderedWinnerIds = orderBySeatAfterDealer(winners.map((winner) => winner.id));
      for (let i = 0; i < remainder; i += 1) {
        const winnerId = orderedWinnerIds[i % orderedWinnerIds.length];
        payoutMap.set(winnerId, payoutMap.get(winnerId) + 1);
      }
    }
  }

  return payoutMap;
}

function orderBySeatAfterDealer(playerIds) {
  const ordered = getRingOrder(state.dealerId).map((player) => player.id);
  return ordered.filter((playerId) => playerIds.includes(playerId));
}

function finishHand() {
  state.handInProgress = false;
  state.currentTurnId = null;
  state.currentBet = 0;
  state.lastRaiseSize = state.bigBlind;
  state.smallBlindId = null;
  state.bigBlindId = null;
  state.deck = [];
  state.burnCards = [];
  state.seenCards = new Set();

  for (const player of state.players) {
    resetPlayerHandState(player);
  }

  cleanupDisconnectedPlayers();
  assignAdminIfNeeded();

  const eligible = state.players.filter((player) => !player.disconnected && player.chips > 0);
  if (state.gameStarted && eligible.length >= 2) {
    addLog(`Next hand in ${Math.floor(NEXT_HAND_DELAY_MS / 1000)} seconds.`);
    emitStateToAll();
    queueNextHand();
    return;
  }

  state.gameStarted = false;
  state.phase = "lobby";
  cancelNextHandTimer();

  if (eligible.length === 1) {
    addLog(`${eligible[0].name} wins the game.`);
  } else {
    addLog("Game ended.");
  }

  emitStateToAll();
}

function resetPlayerHandState(player) {
  player.inHand = false;
  player.folded = false;
  player.allIn = false;
  player.holeCards = [];
  player.betThisRound = 0;
  player.totalContribution = 0;
  player.acted = false;
}

function commitBet(player, amount) {
  if (amount <= 0) {
    return;
  }
  player.chips -= amount;
  player.betThisRound += amount;
  player.totalContribution += amount;
  state.pot += amount;
}

function sendError(playerId, message) {
  const socket = io.sockets.sockets.get(playerId);
  if (socket) {
    socket.emit("errorMessage", message);
  }
}

function getMinRaiseTo() {
  return state.currentBet === 0 ? state.bigBlind : state.currentBet + state.lastRaiseSize;
}

function isPlayerActionable(player) {
  return player.inHand && !player.folded && !player.allIn;
}

function countRemainingInHand() {
  return state.players.filter((player) => player.inHand && !player.folded).length;
}

function isBettingRoundComplete() {
  const actionables = state.players.filter((player) => isPlayerActionable(player));
  if (actionables.length === 0) {
    return true;
  }
  return actionables.every((player) => player.acted && player.betThisRound === state.currentBet);
}

function handleDisconnect(playerId) {
  const player = findPlayer(playerId);
  if (!player) {
    return;
  }

  const name = player.name;
  player.disconnected = true;
  player.isAdmin = false;
  addLog(`${name} disconnected.`);
  assignAdminIfNeeded();

  if (state.handInProgress && player.inHand && !player.folded) {
    if (player.allIn) {
      addLog(`${name} is all-in; hand will continue to showdown.`);
    } else {
      player.folded = true;
      player.inHand = false;
      player.acted = true;
      addLog(`${name} folds due to disconnect.`);

      if (state.currentTurnId === player.id) {
        advanceAfterAction(player.id);
        return;
      }
      if (countRemainingInHand() <= 1) {
        resolveHandByFold();
        return;
      }
    }
  } else if (!state.handInProgress) {
    cleanupDisconnectedPlayers();
  }

  if (state.gameStarted && !state.handInProgress) {
    const eligible = state.players.filter((seat) => !seat.disconnected && seat.chips > 0);
    if (eligible.length < 2) {
      state.gameStarted = false;
      state.phase = "lobby";
      cancelNextHandTimer();
      addLog("Game stopped: not enough players.");
    }
  }

  emitStateToAll();
}

function getNextPlayer(fromPlayerId, predicate) {
  const ordered = getRingOrder(fromPlayerId);
  for (const player of ordered) {
    if (predicate(player)) {
      return player;
    }
  }
  return null;
}

function getRingOrder(fromPlayerId) {
  if (state.players.length === 0) {
    return [];
  }
  let startIndex = fromPlayerId ? state.players.findIndex((player) => player.id === fromPlayerId) : -1;
  if (startIndex < 0) {
    startIndex = -1;
  }
  const result = [];
  for (let i = 1; i <= state.players.length; i += 1) {
    const index = (startIndex + i) % state.players.length;
    result.push(state.players[index]);
  }
  return result;
}

function createDeck() {
  const suits = ["S", "H", "D", "C"];
  const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push(`${rank}${suit}`);
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function burnTopCard() {
  const burnedCard = drawCard("burning");
  state.burnCards.push(burnedCard);
  addLog("Dealer burns a card.");
}

function drawCard(reason = "drawing") {
  const card = state.deck.pop();
  if (!card) {
    throw new Error(`Deck is empty while ${reason}.`);
  }
  if (state.seenCards.has(card)) {
    throw new Error(`Duplicate card detected (${card}) while ${reason}.`);
  }
  state.seenCards.add(card);
  return card;
}

function assertDeckShape(deck) {
  if (!Array.isArray(deck) || deck.length !== FULL_DECK_SIZE) {
    throw new Error(`Deck must contain exactly ${FULL_DECK_SIZE} cards.`);
  }
  const uniqueCards = new Set(deck);
  if (uniqueCards.size !== FULL_DECK_SIZE) {
    throw new Error("Deck contains duplicate cards.");
  }
  for (const card of uniqueCards) {
    if (!/^[2-9TJQKA][SHDC]$/.test(card)) {
      throw new Error(`Invalid card in deck: ${card}`);
    }
  }
}

function evaluatePreflopStrength(holeCards) {
  const firstRank = rankValue(holeCards[0][0]);
  const secondRank = rankValue(holeCards[1][0]);
  const high = Math.max(firstRank, secondRank);
  const low = Math.min(firstRank, secondRank);
  const suited = holeCards[0][1] === holeCards[1][1];
  const isPair = firstRank === secondRank;

  let score = 0;
  let currentHand = "";

  if (isPair) {
    score = Math.round(58 + high * 2.6);
    currentHand = `Pocket ${rankWordPlural(high)}`;
  } else {
    const gap = high - low - 1;
    score = 18 + high * 2 + low + (suited ? 7 : 0);
    if (gap === 0) {
      score += 6;
    } else if (gap === 1) {
      score += 3;
    } else if (gap >= 3) {
      score -= Math.min(12, (gap - 2) * 3);
    }
    if (high >= 11 && low >= 10) {
      score += 8;
    }
    if (high === 14 && low >= 10) {
      score += 4;
    }
    score = Math.round(score);
    currentHand = `${rankToLabel(high)}-${rankToLabel(low)} ${suited ? "suited" : "offsuit"}`;
  }

  score = clampStrength(score);

  return {
    currentHand,
    strengthScore: score,
    strengthLabel: strengthLabelFromScore(score),
    recommendation: recommendationFromInsight(score, []),
  };
}

function detectDraws(knownCards, madeScore) {
  const draws = [];
  if (state.communityCards.length >= 5) {
    return draws;
  }

  if (!madeScore || madeScore.category < 5) {
    const suitCounts = new Map();
    for (const card of knownCards) {
      const suit = card[1];
      suitCounts.set(suit, (suitCounts.get(suit) || 0) + 1);
    }
    if ([...suitCounts.values()].some((count) => count >= 4)) {
      draws.push("Flush draw");
    }
  }

  if (!madeScore || madeScore.category < 4) {
    const straightDraw = detectStraightDraw(knownCards);
    if (straightDraw === "open") {
      draws.push("Open-ended straight draw");
    } else if (straightDraw === "gutshot") {
      draws.push("Gutshot straight draw");
    }
  }

  return draws;
}

function detectStraightDraw(knownCards) {
  const rankSet = new Set(knownCards.map((card) => rankValue(card[0])));
  if (rankSet.has(14)) {
    rankSet.add(1);
  }

  let hasOpenEnded = false;
  let hasGutshot = false;

  for (let start = 1; start <= 10; start += 1) {
    const sequence = [start, start + 1, start + 2, start + 3, start + 4];
    let present = 0;
    let missingIndex = -1;

    for (let i = 0; i < sequence.length; i += 1) {
      if (rankSet.has(sequence[i])) {
        present += 1;
      } else {
        missingIndex = i;
      }
    }

    if (present === 4) {
      if (missingIndex === 0 || missingIndex === 4) {
        hasOpenEnded = true;
      } else {
        hasGutshot = true;
      }
    }
  }

  if (hasOpenEnded) {
    return "open";
  }
  if (hasGutshot) {
    return "gutshot";
  }
  return "";
}

function scorePostflopStrength(madeScore, draws, communityCount) {
  const baseByCategory = [24, 44, 62, 73, 83, 87, 93, 98, 100];
  let score = baseByCategory[madeScore.category] || 20;

  if (madeScore.category === 0) {
    score += Math.max(0, madeScore.ranks[0] - 10) * 2;
  } else if (madeScore.category === 1) {
    score += Math.max(0, madeScore.ranks[0] - 8) * 2;
  } else if (madeScore.category === 2) {
    score += Math.max(0, madeScore.ranks[0] - 9);
  } else if (madeScore.category === 3) {
    score += Math.max(0, madeScore.ranks[0] - 7);
  } else if (madeScore.category >= 4) {
    score += Math.max(0, (madeScore.ranks[0] || 0) - 10);
  }

  if (draws.includes("Flush draw")) {
    score += 8;
  }
  if (draws.includes("Open-ended straight draw")) {
    score += 6;
  } else if (draws.includes("Gutshot straight draw")) {
    score += 3;
  }

  if (communityCount < 5 && madeScore.category < 4) {
    score = Math.min(score, 97);
  }

  return clampStrength(Math.round(score));
}

function clampStrength(value) {
  return Math.max(1, Math.min(100, value));
}

function strengthLabelFromScore(score) {
  if (score >= 90) {
    return "Monster";
  }
  if (score >= 78) {
    return "Very Strong";
  }
  if (score >= 64) {
    return "Strong";
  }
  if (score >= 50) {
    return "Playable";
  }
  if (score >= 36) {
    return "Marginal";
  }
  return "Weak";
}

function recommendationFromInsight(score, draws) {
  if (score >= 85) {
    return "You are usually ahead. Bet or raise for value.";
  }
  if (score >= 68) {
    return "Solid hand. Keep betting, but watch heavy aggression.";
  }
  if (draws.length > 0 && score >= 42) {
    return "You are drawing. Continue when the price is reasonable.";
  }
  if (score >= 50) {
    return "Medium strength. Prefer pot control against big bets.";
  }
  return "Mostly weak. Check/fold unless you have a strong read.";
}

function evaluateBestKnownHand(cards) {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error("evaluateBestKnownHand expects between 5 and 7 cards.");
  }

  let bestScore = null;
  const selection = [];

  function pickCards(startIndex) {
    if (selection.length === 5) {
      const score = evaluateFiveCardHand(selection);
      if (!bestScore || compareScores(score, bestScore) > 0) {
        bestScore = score;
      }
      return;
    }

    for (let i = startIndex; i <= cards.length - (5 - selection.length); i += 1) {
      selection.push(cards[i]);
      pickCards(i + 1);
      selection.pop();
    }
  }

  pickCards(0);
  return bestScore;
}

function evaluateBestHand(cards) {
  if (cards.length !== 7) {
    throw new Error("evaluateBestHand expects exactly 7 cards.");
  }
  return evaluateBestKnownHand(cards);
}

function evaluateFiveCardHand(cards) {
  const ranks = cards.map((card) => rankValue(card[0])).sort((a, b) => b - a);
  const suits = cards.map((card) => card[1]);
  const isFlush = suits.every((suit) => suit === suits[0]);
  const straightHigh = getStraightHigh(ranks);

  const rankCounts = new Map();
  for (const rank of ranks) {
    rankCounts.set(rank, (rankCounts.get(rank) || 0) + 1);
  }

  const groups = [...rankCounts.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((left, right) => right.count - left.count || right.rank - left.rank);

  if (isFlush && straightHigh > 0) {
    return { category: 8, ranks: [straightHigh] };
  }
  if (groups[0].count === 4) {
    return { category: 7, ranks: [groups[0].rank, groups[1].rank] };
  }
  if (groups[0].count === 3 && groups[1].count === 2) {
    return { category: 6, ranks: [groups[0].rank, groups[1].rank] };
  }
  if (isFlush) {
    return { category: 5, ranks };
  }
  if (straightHigh > 0) {
    return { category: 4, ranks: [straightHigh] };
  }
  if (groups[0].count === 3) {
    const kickers = groups.filter((group) => group.count === 1).map((group) => group.rank).sort((a, b) => b - a);
    return { category: 3, ranks: [groups[0].rank, ...kickers] };
  }
  if (groups[0].count === 2 && groups[1].count === 2) {
    const pairRanks = [groups[0].rank, groups[1].rank].sort((a, b) => b - a);
    const kicker = groups.find((group) => group.count === 1).rank;
    return { category: 2, ranks: [pairRanks[0], pairRanks[1], kicker] };
  }
  if (groups[0].count === 2) {
    const kickers = groups.filter((group) => group.count === 1).map((group) => group.rank).sort((a, b) => b - a);
    return { category: 1, ranks: [groups[0].rank, ...kickers] };
  }
  return { category: 0, ranks };
}

function compareScores(left, right) {
  if (left.category !== right.category) {
    return left.category - right.category;
  }
  const maxLength = Math.max(left.ranks.length, right.ranks.length);
  for (let i = 0; i < maxLength; i += 1) {
    const l = left.ranks[i] || 0;
    const r = right.ranks[i] || 0;
    if (l !== r) {
      return l - r;
    }
  }
  return 0;
}

function describeScore(score) {
  const base = HAND_NAMES[score.category];
  if (score.category === 4 || score.category === 8) {
    return `${base} (${rankToLabel(score.ranks[0])} high)`;
  }
  if (score.category === 7) {
    return `${base} (${rankToLabel(score.ranks[0])}s)`;
  }
  if (score.category === 6) {
    return `${base} (${rankToLabel(score.ranks[0])} over ${rankToLabel(score.ranks[1])})`;
  }
  return base;
}

function describeScoreDetailed(score) {
  if (score.category === 0) {
    return `High Card (${rankWord(score.ranks[0])})`;
  }
  if (score.category === 1) {
    return `One Pair (${rankWordPlural(score.ranks[0])})`;
  }
  if (score.category === 2) {
    return `Two Pair (${rankWordPlural(score.ranks[0])} and ${rankWordPlural(score.ranks[1])})`;
  }
  if (score.category === 3) {
    return `Three of a Kind (${rankWordPlural(score.ranks[0])})`;
  }
  if (score.category === 4) {
    return `Straight (${rankWord(score.ranks[0])} high)`;
  }
  if (score.category === 5) {
    return `Flush (${rankWord(score.ranks[0])} high)`;
  }
  if (score.category === 6) {
    return `Full House (${rankWordPlural(score.ranks[0])} over ${rankWordPlural(score.ranks[1])})`;
  }
  if (score.category === 7) {
    return `Four of a Kind (${rankWordPlural(score.ranks[0])})`;
  }
  return `Straight Flush (${rankWord(score.ranks[0])} high)`;
}

function getStraightHigh(sortedRanksDesc) {
  const unique = [...new Set(sortedRanksDesc)];
  if (unique.length !== 5) {
    return 0;
  }
  if (unique[0] - unique[4] === 4) {
    return unique[0];
  }
  const wheel = [14, 5, 4, 3, 2];
  const isWheel = wheel.every((rank, index) => unique[index] === rank);
  return isWheel ? 5 : 0;
}

function rankValue(rank) {
  if (rank >= "2" && rank <= "9") {
    return Number(rank);
  }
  if (rank === "T") {
    return 10;
  }
  if (rank === "J") {
    return 11;
  }
  if (rank === "Q") {
    return 12;
  }
  if (rank === "K") {
    return 13;
  }
  return 14;
}

function rankToLabel(rank) {
  if (rank <= 10) {
    return String(rank);
  }
  if (rank === 11) {
    return "J";
  }
  if (rank === 12) {
    return "Q";
  }
  if (rank === 13) {
    return "K";
  }
  return "A";
}

function rankWord(rank) {
  const words = {
    2: "Two",
    3: "Three",
    4: "Four",
    5: "Five",
    6: "Six",
    7: "Seven",
    8: "Eight",
    9: "Nine",
    10: "Ten",
    11: "Jack",
    12: "Queen",
    13: "King",
    14: "Ace",
  };
  return words[rank] || String(rank);
}

function rankWordPlural(rank) {
  const plurals = {
    2: "Twos",
    3: "Threes",
    4: "Fours",
    5: "Fives",
    6: "Sixes",
    7: "Sevens",
    8: "Eights",
    9: "Nines",
    10: "Tens",
    11: "Jacks",
    12: "Queens",
    13: "Kings",
    14: "Aces",
  };
  return plurals[rank] || `${rank}s`;
}

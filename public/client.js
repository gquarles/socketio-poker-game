const socket = io();
const MAX_TABLE_SEATS = 6;
const CARD_CODE_PATTERN = /^[2-9TJQKA][SHDC]$/;

const elements = {
  joinScreen: document.getElementById("joinScreen"),
  gameScreen: document.getElementById("gameScreen"),
  joinForm: document.getElementById("joinForm"),
  nameInput: document.getElementById("nameInput"),
  statusLine: document.getElementById("statusLine"),

  handNumber: document.getElementById("handNumber"),
  phase: document.getElementById("phase"),
  pot: document.getElementById("pot"),
  metaPot: document.getElementById("metaPot"),
  currentBet: document.getElementById("currentBet"),
  deckRemaining: document.getElementById("deckRemaining"),
  burnCount: document.getElementById("burnCount"),
  communityCards: document.getElementById("communityCards"),

  adminControls: document.getElementById("adminControls"),
  stackInput: document.getElementById("stackInput"),
  setStackBtn: document.getElementById("setStackBtn"),
  startBtn: document.getElementById("startBtn"),

  handIndicator: document.getElementById("handIndicator"),
  handWinProb: document.getElementById("handWinProb"),
  handCurrent: document.getElementById("handCurrent"),
  handLabel: document.getElementById("handLabel"),
  handDraws: document.getElementById("handDraws"),
  handTip: document.getElementById("handTip"),
  strengthMeter: document.getElementById("strengthMeter"),

  betSlider: document.getElementById("betSlider"),
  betDisplay: document.getElementById("betDisplay"),
  quickMinBtn: document.getElementById("quickMinBtn"),
  quickHalfBtn: document.getElementById("quickHalfBtn"),
  quickPotBtn: document.getElementById("quickPotBtn"),
  quickAllBtn: document.getElementById("quickAllBtn"),

  foldBtn: document.getElementById("foldBtn"),
  callBtn: document.getElementById("callBtn"),
  callLabel: document.getElementById("callLabel"),
  callSub: document.getElementById("callSub"),
  raiseBtn: document.getElementById("raiseBtn"),
  raiseBtnText: document.getElementById("raiseBtnText"),

  logList: document.getElementById("logList"),
  showdownBox: document.getElementById("showdownBox"),
  seatNodes: [...document.querySelectorAll(".player-seat")],
};

let latestState = null;
let transientError = "";
let errorTimer = null;

elements.joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = elements.nameInput.value.trim();
  if (!name) {
    return;
  }
  socket.emit("join", { name });
});

elements.setStackBtn.addEventListener("click", () => {
  socket.emit("setStartingStack", { amount: Number(elements.stackInput.value) });
});

elements.startBtn.addEventListener("click", () => {
  socket.emit("startGame");
});

elements.foldBtn.addEventListener("click", () => {
  socket.emit("action", { type: "fold" });
});

elements.callBtn.addEventListener("click", () => {
  if (!latestState) {
    return;
  }
  const actions = latestState.availableActions || {};
  if (latestState.canAct && actions.canCheck) {
    socket.emit("action", { type: "check" });
    return;
  }
  if (latestState.canAct && actions.canCall) {
    socket.emit("action", { type: "call" });
  }
});

elements.raiseBtn.addEventListener("click", () => {
  const amount = Number(elements.betSlider.value);
  socket.emit("action", { type: "raise", amount });
});

elements.betSlider.addEventListener("input", () => {
  updateBetViews(Number(elements.betSlider.value));
});

elements.quickMinBtn.addEventListener("click", () => {
  setQuickBet("min");
});

elements.quickHalfBtn.addEventListener("click", () => {
  setQuickBet("half");
});

elements.quickPotBtn.addEventListener("click", () => {
  setQuickBet("pot");
});

elements.quickAllBtn.addEventListener("click", () => {
  setQuickBet("all");
});

socket.on("errorMessage", (message) => {
  transientError = String(message || "Unknown error");
  if (errorTimer) {
    clearTimeout(errorTimer);
  }
  errorTimer = setTimeout(() => {
    transientError = "";
    if (latestState) {
      renderStatus(latestState);
    }
  }, 3500);
  if (latestState) {
    renderStatus(latestState);
  }
});

socket.on("state", (state) => {
  latestState = state;
  render(state);
});

function render(state) {
  elements.joinScreen.classList.toggle("hidden", state.joined);
  elements.gameScreen.classList.toggle("hidden", !state.joined);
  if (!state.joined) {
    return;
  }

  const you = (state.players || []).find((player) => player.id === state.youId) || null;
  const isAdmin = Boolean(you && you.isAdmin);

  elements.adminControls.classList.toggle("hidden", !(isAdmin && !state.gameStarted));
  elements.stackInput.value = String(state.startingStack);

  elements.handNumber.textContent = String(state.handNumber || 0);
  elements.phase.textContent = String(state.phase || "lobby");
  elements.pot.textContent = formatMoney(state.pot);
  elements.metaPot.textContent = formatMoney(state.pot);
  elements.currentBet.textContent = formatMoney(state.currentBet);
  elements.deckRemaining.textContent = String(state.deckRemaining || 0);
  elements.burnCount.textContent = String(state.burnCount || 0);

  renderStatus(state);
  renderCommunityCards(state);
  renderSeats(state);
  renderLogs(state.logs || []);
  renderShowdown(state.lastShowdown);
  renderHandHelper(state.handInsight);
  renderActions(state);
}

function renderStatus(state) {
  if (transientError) {
    elements.statusLine.textContent = `Error: ${transientError}`;
    return;
  }

  if (!state.gameStarted) {
    elements.statusLine.textContent = "Lobby open. Admin sets starting money and starts the game.";
    return;
  }

  if (!state.handInProgress) {
    elements.statusLine.textContent = "Hand complete. Next hand starts shortly.";
    return;
  }

  const turnPlayer = (state.players || []).find((player) => player.id === state.currentTurnId);
  elements.statusLine.textContent = turnPlayer
    ? `Phase ${state.phase}. Turn: ${turnPlayer.name}.`
    : `Phase ${state.phase}.`;
}

function renderCommunityCards(state) {
  elements.communityCards.innerHTML = "";

  const cards = state.communityCards || [];
  for (let i = 0; i < 5; i += 1) {
    if (i < cards.length) {
      elements.communityCards.appendChild(createCardElement(cards[i]));
    } else if (state.handInProgress) {
      elements.communityCards.appendChild(createCardElement("", { back: true }));
    } else {
      elements.communityCards.appendChild(createCardElement("", { placeholder: true }));
    }
  }
}

function renderSeats(state) {
  const players = getSeatingOrder(state);
  for (let index = 0; index < elements.seatNodes.length; index += 1) {
    const seatNode = elements.seatNodes[index];
    const player = players[index] || null;
    renderSeat(seatNode, player, state);
  }
}

function getSeatingOrder(state) {
  const players = state.players || [];
  if (players.length === 0) {
    return [];
  }

  const youIndex = players.findIndex((player) => player.id === state.youId);
  let ordered = players;

  if (youIndex >= 0) {
    const you = players[youIndex];
    const rest = players.filter((player) => player.id !== you.id);
    ordered = [you, ...rest];
  }

  return ordered.slice(0, MAX_TABLE_SEATS);
}

function renderSeat(seatNode, player, state) {
  seatNode.innerHTML = "";
  seatNode.classList.remove("active-turn", "player-folded", "seat-empty");

  if (!player) {
    seatNode.classList.add("seat-empty");
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "--";
    const info = document.createElement("div");
    info.className = "player-info";
    const name = document.createElement("div");
    name.className = "player-name";
    name.textContent = "Open Seat";
    const stack = document.createElement("div");
    stack.className = "player-stack";
    stack.textContent = "$0";
    info.append(name, stack);
    seatNode.append(avatar, info);
    return;
  }

  const isHero = player.id === state.youId;
  seatNode.classList.toggle("active-turn", Boolean(player.isTurn));
  seatNode.classList.toggle("player-folded", Boolean(player.folded));

  if (player.betThisRound > 0) {
    const currentBet = document.createElement("div");
    currentBet.className = "current-bet";
    currentBet.textContent = `$${formatMoney(player.betThisRound)}`;
    seatNode.appendChild(currentBet);
  }

  const playerCards = document.createElement("div");
  playerCards.className = "player-cards";
  appendPlayerCards(playerCards, player, state, isHero);
  seatNode.appendChild(playerCards);

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = initials(player.name);

  if (player.isTurn) {
    const timerBar = document.createElement("div");
    timerBar.className = "timer-bar";
    avatar.appendChild(timerBar);
  }

  if (player.id === state.dealerId) {
    const dealerButton = document.createElement("div");
    dealerButton.className = "dealer-button";
    dealerButton.textContent = "D";
    avatar.appendChild(dealerButton);
  }

  seatNode.appendChild(avatar);

  const info = document.createElement("div");
  info.className = "player-info";

  const name = document.createElement("div");
  name.className = "player-name";
  name.textContent = isHero ? `${player.name} (You)` : player.name;

  const stack = document.createElement("div");
  stack.className = "player-stack";
  stack.textContent = `$${formatMoney(player.chips)}`;

  info.append(name, stack);

  const flags = renderSeatFlags(player, state);
  if (flags.childNodes.length > 0) {
    info.appendChild(flags);
  }

  seatNode.appendChild(info);
}

function appendPlayerCards(container, player, state, isHero) {
  if (isHero && player.inHand && !player.folded && (state.yourCards || []).length === 2) {
    for (const card of state.yourCards) {
      container.appendChild(createCardElement(card));
    }
    return;
  }

  if (player.inHand && !player.folded) {
    container.appendChild(createCardElement("", { back: true }));
    container.appendChild(createCardElement("", { back: true }));
    return;
  }

  if (player.folded) {
    const first = createCardElement("", { back: true });
    const second = createCardElement("", { back: true });
    first.style.opacity = "0.6";
    second.style.opacity = "0.6";
    container.append(first, second);
  }
}

function renderSeatFlags(player, state) {
  const wrap = document.createElement("div");
  wrap.className = "seat-flags";

  addSeatFlag(wrap, player.isAdmin, "Admin");
  addSeatFlag(wrap, player.id === state.smallBlindId, "SB");
  addSeatFlag(wrap, player.id === state.bigBlindId, "BB");
  addSeatFlag(wrap, player.allIn, "All-In");
  addSeatFlag(wrap, player.folded, "Folded");
  addSeatFlag(wrap, player.id === state.currentTurnId, "Turn");

  return wrap;
}

function addSeatFlag(container, condition, label) {
  if (!condition) {
    return;
  }
  const badge = document.createElement("span");
  badge.className = "seat-flag";
  badge.textContent = label;
  container.appendChild(badge);
}

function renderLogs(logs) {
  elements.logList.innerHTML = "";
  const recent = logs.slice(-28);
  for (const log of recent) {
    const line = document.createElement("div");
    line.className = "log-msg";
    line.textContent = `[${log.at}] ${log.text}`;
    elements.logList.appendChild(line);
  }
  elements.logList.scrollTop = elements.logList.scrollHeight;
}

function renderShowdown(lastShowdown) {
  if (!lastShowdown) {
    elements.showdownBox.textContent = "No showdown yet.";
    return;
  }

  elements.showdownBox.innerHTML = "";

  const board = document.createElement("div");
  board.className = "showdown-line";
  board.textContent = `Board: ${formatCards(lastShowdown.communityCards) || "None"}`;
  elements.showdownBox.appendChild(board);

  const payouts = document.createElement("div");
  payouts.className = "showdown-line";
  payouts.textContent =
    lastShowdown.payouts.length > 0
      ? `Payouts: ${lastShowdown.payouts.map((row) => `${row.name} +$${formatMoney(row.amount)}`).join(" | ")}`
      : "Payouts: none";
  elements.showdownBox.appendChild(payouts);

  for (const hand of lastShowdown.hands) {
    const handLine = document.createElement("div");
    handLine.className = "showdown-line";
    handLine.textContent = `${hand.name}: ${formatCards(hand.cards)} (${hand.handName})`;
    elements.showdownBox.appendChild(handLine);
  }
}

function renderHandHelper(insight) {
  const segments = [...elements.strengthMeter.querySelectorAll(".strength-segment")];

  if (!insight) {
    elements.handWinProb.textContent = "Win: --%";
    elements.handCurrent.textContent = "Waiting for your next hand";
    elements.handLabel.textContent = "Strength: -";
    elements.handDraws.textContent = "Draws: none";
    elements.handTip.textContent = "Tip: join a hand to see guidance.";
    elements.handIndicator.style.borderLeftColor = "#4caf50";
    segments.forEach((segment) => {
      segment.className = "strength-segment";
    });
    return;
  }

  const score = clamp(Number(insight.strengthScore) || 1, 1, 100);
  const activeSegments = clamp(Math.ceil(score / (100 / 6)), 1, 6);
  const accent = scoreToAccent(score);

  elements.handWinProb.textContent = `Win: ${score}%`;
  elements.handCurrent.textContent = insight.currentHand;
  elements.handLabel.textContent = `Strength: ${insight.strengthLabel} (${score}/100)`;
  elements.handDraws.textContent =
    insight.draws && insight.draws.length > 0 ? `Draws: ${insight.draws.join(" | ")}` : "Draws: none";
  elements.handTip.textContent = `Tip: ${insight.recommendation}`;
  elements.handIndicator.style.borderLeftColor = accent;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    segment.className = "strength-segment";
    if (index < activeSegments) {
      segment.classList.add(`active-${index + 1}`);
    }
  }
}

function renderActions(state) {
  const actions = state.availableActions || {};
  const canAct = Boolean(state.canAct);

  elements.foldBtn.disabled = !(canAct && actions.canFold);

  const canCheck = canAct && actions.canCheck;
  const canCall = canAct && actions.canCall;
  elements.callBtn.disabled = !(canCheck || canCall);
  elements.callLabel.textContent = canCheck ? "Check" : "Call";
  elements.callSub.textContent = canCheck ? "$0" : `$${formatMoney(actions.callAmount || 0)}`;

  const canRaise = canAct && actions.canRaise;
  elements.raiseBtn.disabled = !canRaise;
  elements.betSlider.disabled = !canRaise;
  elements.quickMinBtn.disabled = !canRaise;
  elements.quickHalfBtn.disabled = !canRaise;
  elements.quickPotBtn.disabled = !canRaise;
  elements.quickAllBtn.disabled = !canRaise;

  if (canRaise) {
    const minRaiseTo = Math.max(0, Number(actions.minRaiseTo) || 0);
    const maxRaiseTo = Math.max(minRaiseTo, Number(actions.maxRaiseTo) || minRaiseTo);
    let sliderValue = Number(elements.betSlider.value) || minRaiseTo;

    if (sliderValue < minRaiseTo || sliderValue > maxRaiseTo) {
      sliderValue = minRaiseTo;
    }

    elements.betSlider.min = String(minRaiseTo);
    elements.betSlider.max = String(maxRaiseTo);
    elements.betSlider.value = String(sliderValue);
    updateBetViews(sliderValue);
  } else {
    elements.betSlider.min = "0";
    elements.betSlider.max = "0";
    elements.betSlider.value = "0";
    updateBetViews(0);
  }
}

function setQuickBet(kind) {
  if (!latestState) {
    return;
  }

  const actions = latestState.availableActions || {};
  if (!(latestState.canAct && actions.canRaise)) {
    return;
  }

  const minRaiseTo = Math.max(0, Number(actions.minRaiseTo) || 0);
  const maxRaiseTo = Math.max(minRaiseTo, Number(actions.maxRaiseTo) || minRaiseTo);

  let target = minRaiseTo;
  if (kind === "half") {
    target = (latestState.currentBet || 0) + Math.ceil((latestState.pot || 0) / 2);
  } else if (kind === "pot") {
    target = (latestState.currentBet || 0) + (latestState.pot || 0);
  } else if (kind === "all") {
    target = maxRaiseTo;
  }

  const clamped = clamp(Math.round(target), minRaiseTo, maxRaiseTo);
  elements.betSlider.value = String(clamped);
  updateBetViews(clamped);
}

function updateBetViews(value) {
  const display = `$${formatMoney(value)}`;
  elements.betDisplay.textContent = display;
  elements.raiseBtnText.textContent = display;
}

function createCardElement(card, options = {}) {
  const el = document.createElement("div");
  el.className = "card";

  if (options.back) {
    el.classList.add("card-back");
    return el;
  }

  if (options.placeholder) {
    el.classList.add("card-placeholder");
    return el;
  }

  const svgPath = cardToSvgPath(card);
  if (!svgPath) {
    el.classList.add("card-placeholder");
    return el;
  }

  const face = document.createElement("img");
  face.className = "card-face";
  face.src = svgPath;
  face.alt = prettyCard(card);
  face.draggable = false;
  face.decoding = "async";

  el.appendChild(face);
  return el;
}

function parseCard(card) {
  if (typeof card !== "string") {
    return null;
  }

  const normalized = card.trim().toUpperCase();
  if (!CARD_CODE_PATTERN.test(normalized)) {
    return null;
  }

  const rankCode = normalized[0];
  const rank = rankCode === "T" ? "10" : rankCode;
  const suitCode = normalized[1];
  const suitSymbol = suitToSymbol(suitCode);
  return { rankCode, rank, suitCode, suitSymbol };
}

function initials(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function formatCards(cards) {
  return (cards || []).map((card) => prettyCard(card)).join(" ");
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function scoreToAccent(score) {
  if (score >= 78) {
    return "#4caf50";
  }
  if (score >= 62) {
    return "#f4b41a";
  }
  if (score >= 44) {
    return "#fb8c00";
  }
  return "#e53935";
}

function prettyCard(card) {
  const parsed = parseCard(card);
  if (!parsed) {
    return "?";
  }
  return `${parsed.rank}${parsed.suitSymbol}`;
}

function cardToSvgPath(card) {
  const parsed = parseCard(card);
  if (!parsed) {
    return "";
  }

  const rank = rankCodeToFilename(parsed.rankCode);
  const suit = suitCodeToFilename(parsed.suitCode);
  if (!rank || !suit) {
    return "";
  }

  return `/cards/${rank}_of_${suit}.svg`;
}

function suitToSymbol(suitCode) {
  if (suitCode === "S") {
    return "\u2660";
  }
  if (suitCode === "H") {
    return "\u2665";
  }
  if (suitCode === "D") {
    return "\u2666";
  }
  if (suitCode === "C") {
    return "\u2663";
  }
  return "?";
}

function rankCodeToFilename(rankCode) {
  if (rankCode === "A") {
    return "ace";
  }
  if (rankCode === "K") {
    return "king";
  }
  if (rankCode === "Q") {
    return "queen";
  }
  if (rankCode === "J") {
    return "jack";
  }
  if (rankCode === "T") {
    return "10";
  }
  if (rankCode >= "2" && rankCode <= "9") {
    return rankCode;
  }
  return "";
}

function suitCodeToFilename(suitCode) {
  if (suitCode === "S") {
    return "spades";
  }
  if (suitCode === "H") {
    return "hearts";
  }
  if (suitCode === "D") {
    return "diamonds";
  }
  if (suitCode === "C") {
    return "clubs";
  }
  return "";
}

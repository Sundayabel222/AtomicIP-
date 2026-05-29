/**
 * Batch Auction Runner
 * ────────────────────
 * Runs the full auction lifecycle for multiple IPs in one batch operation.
 *
 * Auction lifecycle:
 *   CREATED → ACTIVE (bidding open) → FINALIZED (swap created)
 *
 * Modes:
 *   - start:    Create auctions from scratch
 *   - bid:      Place new bids on active auctions
 *   - finalize: Finalize ended auctions, create swaps for winners
 *   - full:     Complete lifecycle (start → bid → finalize)
 *
 * Rules:
 *  - Each auction requires an IP ID, seller, token, min_bid, and duration
 *  - Bids must meet or exceed the minimum bid and the current highest bid
 *  - Auctions cannot be finalized before their end time
 *  - Finalized auctions create a swap record for the winner
 */

const AUCTION_STATES = Object.freeze({
  CREATED:   "CREATED",
  ACTIVE:    "ACTIVE",
  FINALIZED: "FINALIZED",
  EXPIRED:   "EXPIRED",
});

const RUN_MODES = Object.freeze({
  START:    "start",
  BID:      "bid",
  FINALIZE: "finalize",
  FULL:     "full",
});

const MAX_BATCH_SIZE = 50;
const DEFAULT_DURATION_SECONDS = 604800; // 7 days
const MIN_DURATION_SECONDS = 60;
const MAX_DURATION_SECONDS = 86400 * 365; // 1 year

const VALID_MODES = new Set(Object.values(RUN_MODES));

function validateAuctionEntry(entry, index) {
  if (!entry || typeof entry !== "object")
    throw new TypeError(`Auction at index ${index} must be an object.`);
  if (entry.auctionId != null && typeof entry.auctionId !== "number")
    throw new TypeError(`Auction at index ${index}: auctionId must be a number if provided.`);
  if (typeof entry.ipId !== "number" || entry.ipId <= 0)
    throw new RangeError(`Auction at index ${index}: ipId must be a positive number.`);
  if (!entry.seller || typeof entry.seller !== "string")
    throw new TypeError(`Auction at index ${index}: seller is required.`);
  if (!entry.token || typeof entry.token !== "string")
    throw new TypeError(`Auction at index ${index}: token is required.`);
  if (typeof entry.minBid !== "number" || entry.minBid <= 0)
    throw new RangeError(`Auction at index ${index}: minBid must be a positive number.`);
  if (entry.durationSeconds != null) {
    if (typeof entry.durationSeconds !== "number" || entry.durationSeconds < MIN_DURATION_SECONDS)
      throw new RangeError(
        `Auction at index ${index}: durationSeconds must be at least ${MIN_DURATION_SECONDS}.`
      );
    if (entry.durationSeconds > MAX_DURATION_SECONDS)
      throw new RangeError(
        `Auction at index ${index}: durationSeconds must not exceed ${MAX_DURATION_SECONDS}.`
      );
  }
}

function validateMode(mode) {
  if (!VALID_MODES.has(mode))
    throw new TypeError(`Unknown run mode '${mode}'. Valid modes: ${[...VALID_MODES].join(", ")}.`);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function createAuctionEntry(entry, index, now) {
  const auctionId = entry.auctionId ?? index + 1;
  const startTime = entry.startTime ?? now;
  const duration = entry.durationSeconds ?? DEFAULT_DURATION_SECONDS;
  const endTime = startTime + duration;

  return {
    auctionId,
    ipId: entry.ipId,
    seller: entry.seller,
    token: entry.token,
    minBid: entry.minBid,
    highestBid: 0,
    highestBidder: null,
    startTime,
    endTime,
    state: AUCTION_STATES.ACTIVE,
    finalized: false,
    bids: [],
    swapCreated: false,
    swapId: null,
  };
}

function processBids(auction, bids) {
  if (!bids || bids.length === 0) return auction;

  let currentAuction = { ...auction };

  for (let i = 0; i < bids.length; i++) {
    const bid = bids[i];
    if (!bid || typeof bid !== "object") continue;
    if (!bid.bidder || typeof bid.bidder !== "string") continue;
    if (typeof bid.amount !== "number" || bid.amount <= 0) continue;

    if (bid.amount < currentAuction.minBid) continue;
    if (bid.amount <= currentAuction.highestBid) continue;

    const refundAmount = currentAuction.highestBidder
      ? currentAuction.highestBid
      : 0;

    currentAuction = {
      ...currentAuction,
      highestBid: bid.amount,
      highestBidder: bid.bidder,
      bids: [
        ...currentAuction.bids,
        {
          bidder: bid.bidder,
          amount: bid.amount,
          timestamp: nowSeconds(),
          previousBidderRefund: refundAmount,
        },
      ],
    };
  }

  return currentAuction;
}

function finalizeAuction(auction, now) {
  if (auction.state === AUCTION_STATES.FINALIZED) {
    throw new Error(`Auction ${auction.auctionId}: already finalized.`);
  }

  if (now < auction.endTime) {
    throw new Error(
      `Auction ${auction.auctionId}: cannot finalize before end time (${auction.endTime} > ${now}).`
    );
  }

  const swapId = auction.highestBidder ? auction.auctionId + 10000 : null;

  return {
    ...auction,
    state: AUCTION_STATES.FINALIZED,
    finalized: true,
    swapCreated: !!auction.highestBidder,
    swapId,
  };
}

function runOne(entry, index, mode, now) {
  validateAuctionEntry(entry, index);

  let auction;
  const duration = entry.durationSeconds ?? DEFAULT_DURATION_SECONDS;

  if (mode === RUN_MODES.START) {
    auction = createAuctionEntry(entry, index, now);
  } else if (mode === RUN_MODES.FULL) {
    auction = createAuctionEntry(entry, index, now);
    const newBids = entry.bids ?? entry.newBids ?? [];
    auction = processBids(auction, newBids);
  } else if (mode === RUN_MODES.BID) {
    auction = {
      auctionId: entry.auctionId ?? index + 1,
      ipId: entry.ipId,
      seller: entry.seller,
      token: entry.token,
      minBid: entry.minBid,
      highestBid: entry.highestBid ?? 0,
      highestBidder: entry.highestBidder ?? null,
      startTime: entry.startTime ?? now,
      endTime: entry.endTime ?? now + duration,
      state: AUCTION_STATES.ACTIVE,
      finalized: false,
      bids: [],
      swapCreated: false,
      swapId: null,
    };
    const newBids = entry.bids ?? entry.newBids ?? [];
    auction = processBids(auction, newBids);
  } else {
    auction = {
      auctionId: entry.auctionId ?? index + 1,
      ipId: entry.ipId,
      seller: entry.seller,
      token: entry.token,
      minBid: entry.minBid,
      highestBid: entry.highestBid ?? 0,
      highestBidder: entry.highestBidder ?? null,
      startTime: entry.startTime ?? now,
      endTime: entry.endTime ?? now + duration,
      state: entry.state ?? AUCTION_STATES.ACTIVE,
      finalized: entry.finalized ?? false,
      bids: entry.bids ?? [],
      swapCreated: entry.swapCreated ?? false,
      swapId: entry.swapId ?? null,
    };
  }

  if (mode === RUN_MODES.FINALIZE) {
    auction = finalizeAuction(auction, now);
  }

  if (mode === RUN_MODES.FULL && now >= auction.endTime) {
    auction = finalizeAuction(auction, now);
  }

  return auction;
}

function runBatchAuctions(auctions, options = {}) {
  if (!Array.isArray(auctions) || auctions.length === 0)
    throw new TypeError("auctions must be a non-empty array.");
  if (auctions.length > MAX_BATCH_SIZE)
    throw new RangeError(`Batch size ${auctions.length} exceeds maximum of ${MAX_BATCH_SIZE}.`);

  const mode = options.mode ?? RUN_MODES.FULL;
  validateMode(mode);

  const now = options.now ?? nowSeconds();

  const results = [];
  const errors = [];

  for (let i = 0; i < auctions.length; i++) {
    try {
      results.push(runOne(auctions[i], i, mode, now));
    } catch (err) {
      errors.push({
        index: i,
        auctionId: auctions[i]?.auctionId ?? null,
        ipId: auctions[i]?.ipId ?? null,
        error: err.message,
      });
    }
  }

  const active = results.filter((r) => r.state === AUCTION_STATES.ACTIVE);
  const finalized = results.filter((r) => r.state === AUCTION_STATES.FINALIZED);
  const totalBids = results.reduce((s, r) => s + r.bids.length, 0);
  const totalWinningBids = finalized.reduce((s, r) => s + r.highestBid, 0);
  const swapsCreated = finalized.filter((r) => r.swapCreated).length;

  return {
    batchSize: auctions.length,
    mode,
    runCount: results.length,
    failedCount: errors.length,
    activeCount: active.length,
    finalizedCount: finalized.length,
    swapsCreated,
    totalBidsReceived: totalBids,
    totalWinningBidValue: +totalWinningBids.toFixed(8),
    results,
    errors,
  };
}

module.exports = {
  runBatchAuctions,
  AUCTION_STATES,
  RUN_MODES,
  MAX_BATCH_SIZE,
  DEFAULT_DURATION_SECONDS,
};

const {
  runBatchAuctions,
  AUCTION_STATES,
  RUN_MODES,
  MAX_BATCH_SIZE,
  DEFAULT_DURATION_SECONDS,
} = require("../batch/batchAuctionRunner");

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

const auction = (overrides = {}) => ({
  ipId: 1,
  seller: "seller-1",
  token: "XLM",
  minBid: 100,
  durationSeconds: DAY,
  ...overrides,
});

describe("runBatchAuctions — validation", () => {
  test("throws on empty auctions array", () => {
    expect(() => runBatchAuctions([])).toThrow(TypeError);
  });

  test("throws on batch > MAX_BATCH_SIZE", () => {
    const big = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => auction({ ipId: i + 1 }));
    expect(() => runBatchAuctions(big)).toThrow(RangeError);
  });

  test("throws on unknown mode", () => {
    expect(() =>
      runBatchAuctions([auction()], { mode: "unknown" })
    ).toThrow(TypeError);
  });

  test("records error for missing seller", () => {
    const result = runBatchAuctions([{ ipId: 1, token: "XLM", minBid: 100 }]);
    expect(result.failedCount).toBe(1);
    expect(result.errors[0].error).toMatch(/seller is required/);
  });

  test("records error for invalid ipId", () => {
    const result = runBatchAuctions([{ ipId: -1, seller: "s", token: "XLM", minBid: 100 }]);
    expect(result.failedCount).toBe(1);
  });

  test("records error for missing token", () => {
    const result = runBatchAuctions([{ ipId: 1, seller: "s", minBid: 100 }]);
    expect(result.failedCount).toBe(1);
    expect(result.errors[0].error).toMatch(/token is required/);
  });

  test("records error for non-positive minBid", () => {
    const result = runBatchAuctions([{ ipId: 1, seller: "s", token: "XLM", minBid: 0 }]);
    expect(result.failedCount).toBe(1);
  });

  test("records error for too-short durationSeconds", () => {
    const result = runBatchAuctions([auction({ durationSeconds: 30 })]);
    expect(result.failedCount).toBe(1);
    expect(result.errors[0].error).toMatch(/durationSeconds must be at least/);
  });

  test("records error for too-long durationSeconds", () => {
    const result = runBatchAuctions([auction({ durationSeconds: 86400 * 366 })]);
    expect(result.failedCount).toBe(1);
    expect(result.errors[0].error).toMatch(/durationSeconds must not exceed/);
  });
});

describe("runBatchAuctions — start mode", () => {
  test("starts a single auction with defaults", () => {
    const result = runBatchAuctions([auction()], { mode: RUN_MODES.START, now: NOW });
    expect(result.runCount).toBe(1);
    expect(result.activeCount).toBe(1);
    expect(result.results[0].state).toBe(AUCTION_STATES.ACTIVE);
    expect(result.results[0].startTime).toBe(NOW);
    expect(result.results[0].endTime).toBe(NOW + DAY);
  });

  test("uses provided auctionId", () => {
    const result = runBatchAuctions(
      [auction({ auctionId: 42 })],
      { mode: RUN_MODES.START, now: NOW }
    );
    expect(result.results[0].auctionId).toBe(42);
  });

  test("auto-assigns auctionId starting from 1", () => {
    const result = runBatchAuctions(
      [auction(), auction()],
      { mode: RUN_MODES.START, now: NOW }
    );
    expect(result.results[0].auctionId).toBe(1);
    expect(result.results[1].auctionId).toBe(2);
  });

  test("respects custom durationSeconds", () => {
    const result = runBatchAuctions(
      [auction({ durationSeconds: 3600 })],
      { mode: RUN_MODES.START, now: NOW }
    );
    expect(result.results[0].endTime).toBe(NOW + 3600);
  });
});

describe("runBatchAuctions — bid mode", () => {
  test("places a valid bid that becomes highest", () => {
    const entry = auction({ bids: [{ bidder: "buyer-1", amount: 200 }] });
    const result = runBatchAuctions([entry], { mode: RUN_MODES.BID, now: NOW });
    expect(result.results[0].highestBid).toBe(200);
    expect(result.results[0].highestBidder).toBe("buyer-1");
    expect(result.totalBidsReceived).toBe(1);
  });

  test("rejects bid below minBid", () => {
    const entry = auction({ bids: [{ bidder: "buyer-1", amount: 50 }] });
    const result = runBatchAuctions([entry], { mode: RUN_MODES.BID, now: NOW });
    expect(result.results[0].highestBid).toBe(0);
    expect(result.results[0].highestBidder).toBeNull();
    expect(result.totalBidsReceived).toBe(0);
  });

  test("rejects bid not higher than current highest", () => {
    const entry = auction({
      highestBid: 200,
      highestBidder: "buyer-1",
      bids: [{ bidder: "buyer-2", amount: 150 }],
    });
    const result = runBatchAuctions([entry], { mode: RUN_MODES.BID, now: NOW });
    expect(result.results[0].highestBid).toBe(200);
    expect(result.results[0].highestBidder).toBe("buyer-1");
  });

  test("outbidding refunds previous highest bidder", () => {
    const entry = auction({
      highestBid: 100,
      highestBidder: "buyer-1",
      bids: [{ bidder: "buyer-2", amount: 300 }],
    });
    const result = runBatchAuctions([entry], { mode: RUN_MODES.BID, now: NOW });
    expect(result.results[0].highestBid).toBe(300);
    expect(result.results[0].highestBidder).toBe("buyer-2");
    expect(result.results[0].bids[0].previousBidderRefund).toBe(100);
  });

  test("processes multiple bids on same auction, keeps highest", () => {
    const entry = auction({
      bids: [
        { bidder: "buyer-1", amount: 150 },
        { bidder: "buyer-2", amount: 250 },
        { bidder: "buyer-3", amount: 200 },
      ],
    });
    const result = runBatchAuctions([entry], { mode: RUN_MODES.BID, now: NOW });
    expect(result.results[0].highestBid).toBe(250);
    expect(result.results[0].highestBidder).toBe("buyer-2");
    expect(result.results[0].bids.length).toBe(2);
  });

  test("counts total bids across multiple auctions", () => {
    const entries = [
      auction({ ipId: 1, bids: [{ bidder: "b1", amount: 200 }] }),
      auction({ ipId: 2, bids: [{ bidder: "b2", amount: 300 }] }),
    ];
    const result = runBatchAuctions(entries, { mode: RUN_MODES.BID, now: NOW });
    expect(result.totalBidsReceived).toBe(2);
  });
});

describe("runBatchAuctions — finalize mode", () => {
  test("finalizes auction after end time", () => {
    const past = NOW - DAY;
    const entry = auction({
      startTime: past,
      endTime: past + DAY,
      highestBid: 500,
      highestBidder: "winner",
    });
    const result = runBatchAuctions([entry], { mode: RUN_MODES.FINALIZE, now: NOW });
    expect(result.results[0].state).toBe(AUCTION_STATES.FINALIZED);
    expect(result.results[0].finalized).toBe(true);
    expect(result.finalizedCount).toBe(1);
  });

  test("creates swap for winner when finalized", () => {
    const past = NOW - DAY;
    const entry = auction({
      startTime: past,
      endTime: past + DAY,
      highestBid: 500,
      highestBidder: "winner",
    });
    const result = runBatchAuctions([entry], { mode: RUN_MODES.FINALIZE, now: NOW });
    expect(result.results[0].swapCreated).toBe(true);
    expect(result.results[0].swapId).toBeTruthy();
    expect(result.swapsCreated).toBe(1);
  });

  test("does not create swap when no winner", () => {
    const past = NOW - DAY;
    const entry = auction({
      startTime: past,
      endTime: past + DAY,
      highestBid: 0,
      highestBidder: null,
    });
    const result = runBatchAuctions([entry], { mode: RUN_MODES.FINALIZE, now: NOW });
    expect(result.results[0].swapCreated).toBe(false);
    expect(result.results[0].swapId).toBeNull();
    expect(result.swapsCreated).toBe(0);
  });

  test("records error when finalizing before end time", () => {
    const future = NOW + DAY;
    const entry = auction({
      startTime: NOW,
      endTime: future,
    });
    const result = runBatchAuctions([entry], { mode: RUN_MODES.FINALIZE, now: NOW });
    expect(result.failedCount).toBe(1);
    expect(result.errors[0].error).toMatch(/cannot finalize before end time/);
  });

  test("records error when already finalized", () => {
    const past = NOW - DAY;
    const entry = auction({
      startTime: past,
      endTime: past + DAY,
      state: AUCTION_STATES.FINALIZED,
      finalized: true,
    });
    const result = runBatchAuctions([entry], { mode: RUN_MODES.FINALIZE, now: NOW });
    expect(result.failedCount).toBe(1);
    expect(result.errors[0].error).toMatch(/already finalized/);
  });

  test("totalWinningBidValue sums winning bids", () => {
    const past = NOW - DAY;
    const entries = [
      auction({ ipId: 1, startTime: past, endTime: past + DAY, highestBid: 300, highestBidder: "w1" }),
      auction({ ipId: 2, startTime: past, endTime: past + DAY, highestBid: 700, highestBidder: "w2" }),
    ];
    const result = runBatchAuctions(entries, { mode: RUN_MODES.FINALIZE, now: NOW });
    expect(result.totalWinningBidValue).toBe(1000);
  });
});

describe("runBatchAuctions — full mode", () => {
  test("full lifecycle: start, bid, finalize", () => {
    const past = NOW - DAY;
    const entry = auction({
      startTime: past,
      durationSeconds: DAY,
      bids: [{ bidder: "winner", amount: 500 }],
    });
    const result = runBatchAuctions([entry], { mode: RUN_MODES.FULL, now: NOW });
    expect(result.results[0].state).toBe(AUCTION_STATES.FINALIZED);
    expect(result.results[0].highestBid).toBe(500);
    expect(result.results[0].swapCreated).toBe(true);
  });

  test("full lifecycle: auction with no bids stays active if not ended", () => {
    const entry = auction({
      durationSeconds: DAY * 7,
    });
    const result = runBatchAuctions([entry], { mode: RUN_MODES.FULL, now: NOW });
    expect(result.results[0].state).toBe(AUCTION_STATES.ACTIVE);
    expect(result.results[0].highestBidder).toBeNull();
    expect(result.results[0].swapCreated).toBe(false);
  });

  test("full lifecycle: auction ends with no winner", () => {
    const past = NOW - DAY;
    const entry = auction({
      startTime: past,
      durationSeconds: DAY,
      bids: [],
    });
    const result = runBatchAuctions([entry], { mode: RUN_MODES.FULL, now: NOW });
    expect(result.results[0].state).toBe(AUCTION_STATES.FINALIZED);
    expect(result.results[0].swapCreated).toBe(false);
    expect(result.results[0].swapId).toBeNull();
  });
});

describe("runBatchAuctions — mode defaults", () => {
  test("default mode is full", () => {
    const past = NOW - DAY;
    const entry = auction({
      startTime: past,
      durationSeconds: DAY,
      bids: [{ bidder: "w", amount: 200 }],
    });
    const result = runBatchAuctions([entry], { now: NOW });
    expect(result.mode).toBe(RUN_MODES.FULL);
    expect(result.results[0].state).toBe(AUCTION_STATES.FINALIZED);
  });
});

describe("runBatchAuctions — mixed batch", () => {
  test("processes valid and invalid entries, counts correctly", () => {
    const entries = [
      auction({ ipId: 1 }),
      { ipId: -1, seller: "s", token: "XLM", minBid: 100 },
      auction({ ipId: 3 }),
    ];
    const result = runBatchAuctions(entries, { mode: RUN_MODES.START, now: NOW });
    expect(result.runCount).toBe(2);
    expect(result.failedCount).toBe(1);
    expect(result.activeCount).toBe(2);
    expect(result.batchSize).toBe(3);
  });
});

describe("runBatchAuctions — aggregate stats", () => {
  test("batchSize equals input array length", () => {
    const result = runBatchAuctions([auction(), auction()], { mode: RUN_MODES.START, now: NOW });
    expect(result.batchSize).toBe(2);
  });

  test("runCount excludes errors", () => {
    const result = runBatchAuctions(
      [auction(), { invalid: true }],
      { mode: RUN_MODES.START, now: NOW }
    );
    expect(result.runCount).toBe(1);
    expect(result.failedCount).toBe(1);
  });
});

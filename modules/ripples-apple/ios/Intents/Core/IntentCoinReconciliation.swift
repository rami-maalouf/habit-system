import Foundation

enum IntentCoinReconciliation {
  struct Result { let appendedRows: [IntentCoinLedgerRow]; let target: Int64; let balance: Int64 }
  private struct Fact {
    let fingerprint: [String]; let action: IntentHabitAction?; let row: IntentCoinLedgerRow?
    var createdAt: Int64 { action?.createdAt ?? row!.createdAt }
    var stamp: String { action?.mutationStamp ?? row!.mutationStamp }
  }

  private static func sum(_ rows: [IntentCoinLedgerRow]) throws -> Int64 {
    try IntentCoinLedgerRow.totals(rows).balance
  }

  private static func validateOrdinary(_ actions: [IntentHabitAction], _ rows: [IntentCoinLedgerRow]) throws {
    let causes = Dictionary(uniqueKeysWithValues: actions.map { ($0.id, $0) })
    let awards = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
    for row in rows {
      guard let cause = row.sourceActionId.flatMap({ causes[$0] }) else { throw IntentCoinError.missing }
      let expected: IntentCoinLedgerRow
      if row.kind == "check" {
        guard cause.kind == "check", let json = cause.policyJson, try IntentCoinPolicy.parse(json).earnsCoins else { throw IntentCoinError.invalid }
        expected = try .check(cause)
      } else {
        guard let award = row.reversesId.flatMap({ awards[$0] }),
          let source = award.sourceActionId.flatMap({ causes[$0] }) else { throw IntentCoinError.missing }
        guard row.kind == "reversal", award.kind == "check", ["uncheck", "move_out"].contains(cause.kind),
          cause.checkInId == nil || cause.checkInId == award.checkInId, let json = source.policyJson,
          try cause.createdAt < IntentCoinPolicy.parse(json).checkClosesAtUtc,
          [source.mutationStamp, source.id].lexicographicallyPrecedes([cause.mutationStamp, cause.id]) else { throw IntentCoinError.invalid }
        expected = try .check(cause, reversing: award)
      }
      guard expected == row else { throw IntentCoinError.invalid }
    }
  }

  private static func evidence(_ actions: [IntentHabitAction], _ rows: [IntentCoinLedgerRow]) throws -> [Fact] {
    var facts = try actions.map { Fact(fingerprint: ["habit_action", $0.id, IntentCoinProvenance.digest(try IntentCoinProvenance.actionCanonical($0))], action: $0, row: nil) }
    facts += try rows.map { Fact(fingerprint: ["ledger_entry", $0.id, IntentCoinProvenance.digest(try $0.canonical())], action: nil, row: $0) }
    return facts.sorted { $0.fingerprint.lexicographicallyPrecedes($1.fingerprint) }
  }

  private static func correction(boardId: String, date: String, actions: [IntentHabitAction], rows: [IntentCoinLedgerRow], facts: [Fact]) throws -> IntentCoinLedgerRow? {
    let replay = try IntentCheckCoins.replay(boardId: boardId, logicalDate: date, actions: actions)
    let saved = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
    guard replay.ordinaryRows.allSatisfy({ saved[$0.id] == $0 }) else { throw IntentCoinError.invalid }
    let delta = replay.target - (try sum(rows))
    if delta == 0 { return nil }
    let proof = try IntentCoinProvenance.canonical(facts.map { $0.fingerprint })
    let digest = IntentCoinProvenance.digest(proof)
    guard let last = facts.max(by: {
      [$0.stamp, $0.fingerprint[1], $0.fingerprint[0]].lexicographicallyPrecedes([$1.stamp, $1.fingerprint[1], $1.fingerprint[0]])
    }) else { throw IntentCoinError.invalid }
    let scope = "check:\(boardId):\(date)"
    let row = IntentCoinLedgerRow(id: IntentHabitAction.uuidV5(name: try IntentCoinJSON.encode(["habit-ledger-v1", "adjustment", scope, digest])),
      kind: "adjustment", delta: delta, boardId: nil, checkInId: nil, runKey: nil, rewardId: nil, rewardTitleSnapshot: nil,
      reversesId: nil, scopeKey: scope, sourceActionId: nil, reconciliationKey: digest, adjustsId: nil, provenanceJson: proof,
      logicalDate: date, createdAt: last.createdAt, mutationStamp: last.stamp, deletedAt: nil)
    try row.validateShape()
    return row
  }

  private static func cancellation(_ old: IntentCoinLedgerRow) -> IntentCoinLedgerRow {
    IntentCoinLedgerRow(id: IntentHabitAction.uuidV5(name: "cancel:\(old.id)"), kind: "adjustment", delta: -old.delta,
      boardId: nil, checkInId: nil, runKey: nil, rewardId: nil, rewardTitleSnapshot: nil, reversesId: nil,
      scopeKey: old.scopeKey, sourceActionId: nil, reconciliationKey: old.reconciliationKey, adjustsId: old.id,
      provenanceJson: old.provenanceJson, logicalDate: old.logicalDate, createdAt: old.createdAt,
      mutationStamp: old.mutationStamp, deletedAt: nil)
  }

  static func reconcile(boardId: String, logicalDate: String, actions inputActions: [IntentHabitAction], rows inputRows: [IntentCoinLedgerRow]) throws -> Result {
    let actions = try IntentCheckCoins.ordered(boardId: boardId, logicalDate: logicalDate, actions: inputActions)
    let replay = try IntentCheckCoins.replay(boardId: boardId, logicalDate: logicalDate, actions: actions)
    let scope = "check:\(boardId):\(logicalDate)"
    var rows: [String: IntentCoinLedgerRow] = [:]
    var appended: [IntentCoinLedgerRow] = []
    for row in inputRows {
      try row.validateShape()
      guard row.scopeKey == scope, ["check", "reversal", "adjustment"].contains(row.kind),
        rows[row.id] == nil || rows[row.id] == row else { throw IntentCoinError.invalid }
      rows[row.id] = row
    }
    func append(_ row: IntentCoinLedgerRow) { if rows[row.id] == nil { rows[row.id] = row; appended.append(row) } }
    try validateOrdinary(actions, rows.values.filter { $0.kind != "adjustment" })
    for row in replay.ordinaryRows { append(row) }
    let ordinary = rows.values.filter { $0.kind != "adjustment" }
    let facts = try evidence(actions, ordinary)
    let available = Dictionary(uniqueKeysWithValues: facts.map { (Array($0.fingerprint.prefix(2)), $0) })
    for row in rows.values where row.kind == "adjustment" && row.adjustsId == nil {
      var subset: [Fact] = []
      for fingerprint in try IntentCoinProvenance.parse(row.provenanceJson!) {
        guard let fact = available[Array(fingerprint.prefix(2))] else { throw IntentCoinError.missing }
        guard fingerprint == fact.fingerprint else { throw IntentCoinError.invalid }
        subset.append(fact)
      }
      let subsetActions = subset.compactMap { $0.action }
      let subsetRows = subset.compactMap { $0.row }
      do { try validateOrdinary(subsetActions, subsetRows) } catch { throw IntentCoinError.invalid }
      guard try correction(boardId: boardId, date: logicalDate, actions: subsetActions, rows: subsetRows, facts: subset) == row else { throw IntentCoinError.invalid }
    }
    for row in rows.values.filter({ $0.kind == "adjustment" }).sorted(by: { $0.id < $1.id }) {
      guard let old = row.adjustsId.flatMap({ rows[$0] }) ?? (row.adjustsId == nil ? row : nil) else { throw IntentCoinError.missing }
      guard old.kind == "adjustment", old.adjustsId == nil else { throw IntentCoinError.invalid }
      if try IntentCoinProvenance.parse(old.provenanceJson!).count >= facts.count {
        if row.adjustsId != nil { throw IntentCoinError.missing }
        continue
      }
      let cancel = cancellation(old)
      try cancel.validateShape()
      guard row.adjustsId == nil || row == cancel else { throw IntentCoinError.invalid }
      append(cancel)
    }
    if let current = try correction(boardId: boardId, date: logicalDate, actions: actions, rows: ordinary, facts: facts) { append(current) }
    return Result(appendedRows: appended, target: replay.target, balance: try sum(Array(rows.values)))
  }
}

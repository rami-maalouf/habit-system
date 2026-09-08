import Foundation
import XCTest
@testable import RipplesIntentCore

final class IntentHabitActionsTests: XCTestCase {
  func testSharedUnicodeAndBaselineIdentityVectors() throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let data = try Data(contentsOf: root.appendingPathComponent("src/core/automations/fixtures/habit-actions.json"))
    let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(IntentHabitAction.namespace, fixture["namespace"] as? String)
    for vector in fixture["uuidVectors"] as! [[String: String]] {
      XCTAssertEqual(IntentHabitAction.uuidV5(name: vector["name"]!), vector["id"])
    }
    let baseline = fixture["baseline"] as! [String: Any]
    let source = baseline["source"] as! [String: String]
    let action = try IntentHabitAction.baseline(checkInId: source["id"]!, boardId: source["boardId"]!, date: source["logicalDate"]!)
    XCTAssertEqual(action.id, baseline["id"] as? String)
    XCTAssertEqual(action.createdAt, baseline["createdAt"] as? Int64)
    XCTAssertEqual(action.mutationStamp, baseline["mutationStamp"] as? String)
    XCTAssertNil(action.commandId)
    XCTAssertNil(action.policyJson)
    for entry in fixture["foldCases"] as! [[String: Any]] {
      let encoded = try JSONSerialization.data(withJSONObject: entry["actions"]!)
      let actions = try JSONDecoder().decode([IntentHabitAction].self, from: encoded)
      let winner = IntentHabitAction.effectiveCheckInId(actions)
      XCTAssertEqual(winner, entry["checkInId"] as? String, entry["name"] as! String)
      XCTAssertEqual(winner != nil, entry["checked"] as? Bool, entry["name"] as! String)
      XCTAssertEqual(IntentHabitAction.effectiveCheckInId(actions.reversed()), winner)
    }
  }
}

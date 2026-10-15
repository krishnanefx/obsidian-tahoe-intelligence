// Tahoe Intelligence helper — one long-running process for on-device models.
//
// JSON lines on stdin/stdout. Each request has an "id"; replies echo it.
//   {"op":"status"}
//   {"op":"generate","instructions":…,"prompt":…,"schema":…?,"stream":bool,"temperature":…,"maxTokens":…}
//       → {"delta":…}* then {"done":true,"text":…} or {"done":true,"json":"…"}
//   {"op":"embed","texts":[…]}   → {"done":true,"dim":512,"vectors":"<base64 Float32>"}
//   {"op":"image","path":…}      → {"done":true,"text":…,"labels":[…]}
//   {"op":"reminders.status"} / {"op":"reminders.request"} → {"done":true,"access":"full|denied|notDetermined|…"}
//   {"op":"reminders.fetch","list":…}  → {"done":true,"items":[…]}   (creates the list if needed)
//   {"op":"reminders.save","list":…,"items":[…]} → {"done":true,"ids":[…]}
//   {"op":"calendar.status"} / {"op":"calendar.request"} → {"done":true,"access":…}
//   {"op":"calendar.events","from":"YYYY-MM-DD","to":"YYYY-MM-DD"} → {"done":true,"events":[…]}
//   {"op":"cancel","target":id}
// Unprompted: {"event":"reminders-changed"} when Reminders changes anywhere.
// Errors: {"done":true,"error":"…","code":"…"}
import Foundation
import FoundationModels
import NaturalLanguage
import Vision
import ImageIO
import EventKit

let outLock = NSLock()
func send(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    outLock.lock()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
    outLock.unlock()
}

// ---------- guided generation: build a schema from the plugin's JSON spec ----------
var schemaCounter = 0
func buildSchema(_ spec: [String: Any], name: String) -> DynamicGenerationSchema {
    let description = spec["description"] as? String
    if let options = spec["enum"] as? [String], !options.isEmpty {
        return DynamicGenerationSchema(name: name, description: description, anyOf: options)
    }
    switch spec["type"] as? String ?? "string" {
    case "object":
        let props = (spec["properties"] as? [[String: Any]] ?? []).map { p -> DynamicGenerationSchema.Property in
            let pname = p["name"] as? String ?? "value"
            schemaCounter += 1
            return DynamicGenerationSchema.Property(
                name: pname,
                description: p["description"] as? String,
                schema: buildSchema(p["schema"] as? [String: Any] ?? [:], name: "\(name)_\(pname)_\(schemaCounter)"),
                isOptional: p["optional"] as? Bool ?? false
            )
        }
        return DynamicGenerationSchema(name: name, description: description, properties: props)
    case "array":
        let items = buildSchema(spec["items"] as? [String: Any] ?? [:], name: name + "Item")
        return DynamicGenerationSchema(arrayOf: items, minimumElements: spec["min"] as? Int, maximumElements: spec["max"] as? Int)
    case "boolean":
        return DynamicGenerationSchema(type: Bool.self)
    case "integer":
        return DynamicGenerationSchema(type: Int.self)
    case "number":
        return DynamicGenerationSchema(type: Double.self)
    default:
        return DynamicGenerationSchema(type: String.self)
    }
}

func errorCode(_ error: Error) -> String {
    if let e = error as? LanguageModelSession.GenerationError {
        switch e {
        case .exceededContextWindowSize: return "context"
        case .guardrailViolation: return "guardrail"
        case .unsupportedLanguageOrLocale: return "language"
        case .assetsUnavailable: return "assets"
        case .rateLimited: return "rate"
        case .concurrentRequests: return "busy"
        case .decodingFailure: return "decoding"
        case .refusal: return "refusal"
        default: return "generation"
        }
    }
    if error is CancellationError { return "cancelled" }
    return "error"
}

func generate(_ id: Any, _ req: [String: Any]) async {
    let model = SystemLanguageModel.default
    if case .unavailable(let reason) = model.availability {
        send(["id": id, "done": true, "error": "Apple Intelligence is unavailable (\(reason))", "code": "unavailable"])
        return
    }
    let session = LanguageModelSession(instructions: req["instructions"] as? String ?? "")
    let options = GenerationOptions(
        temperature: req["temperature"] as? Double,
        maximumResponseTokens: req["maxTokens"] as? Int
    )
    let prompt = req["prompt"] as? String ?? ""
    do {
        if let spec = req["schema"] as? [String: Any] {
            let schema = try GenerationSchema(root: buildSchema(spec, name: "Result"), dependencies: [])
            let response = try await session.respond(to: prompt, schema: schema, includeSchemaInPrompt: true, options: options)
            send(["id": id, "done": true, "json": response.content.jsonString])
        } else if req["stream"] as? Bool == true {
            var printed = ""
            for try await snapshot in session.streamResponse(to: prompt, options: options) {
                let text = snapshot.content
                if text.hasPrefix(printed) {
                    let delta = String(text.dropFirst(printed.count))
                    if !delta.isEmpty { send(["id": id, "delta": delta]) }
                } else {
                    send(["id": id, "reset": text])
                }
                printed = text
            }
            send(["id": id, "done": true, "text": printed])
        } else {
            let response = try await session.respond(to: prompt, options: options)
            send(["id": id, "done": true, "text": response.content])
        }
    } catch {
        send(["id": id, "done": true, "error": "\(error)", "code": errorCode(error)])
    }
}

// ---------- embeddings: mean-pooled contextual embeddings, chunked to fit ----------
let embedder: NLContextualEmbedding? = NLContextualEmbedding(language: .english)
var embedderLoaded = false

func chunks(_ text: String, limit: Int = 900) -> [String] {
    var out: [String] = []
    var current = ""
    for para in text.components(separatedBy: "\n") {
        let p = para.trimmingCharacters(in: .whitespaces)
        if p.isEmpty { continue }
        if current.count + p.count + 1 > limit, !current.isEmpty {
            out.append(current)
            current = ""
        }
        if p.count > limit {
            var rest = Substring(p)
            while rest.count > limit {
                let cut = rest.index(rest.startIndex, offsetBy: limit)
                let space = rest[..<cut].lastIndex(of: " ") ?? cut
                out.append(String(rest[..<space]))
                rest = rest[space...].drop(while: { $0 == " " })
            }
            current = String(rest)
        } else {
            current += (current.isEmpty ? "" : "\n") + p
        }
    }
    if !current.isEmpty { out.append(current) }
    return out.isEmpty ? [" "] : out
}

func embed(_ id: Any, _ req: [String: Any]) {
    guard let e = embedder else {
        send(["id": id, "done": true, "error": "No English embedding model on this Mac", "code": "unavailable"])
        return
    }
    do {
        if !embedderLoaded {
            try e.load()
            embedderLoaded = true
        }
        let texts = req["texts"] as? [String] ?? []
        var floats: [Float32] = []
        floats.reserveCapacity(texts.count * e.dimension)
        for text in texts {
            var sum = [Double](repeating: 0, count: e.dimension)
            var n = 0
            for chunk in chunks(text).prefix(24) {
                let result = try e.embeddingResult(for: chunk, language: .english)
                result.enumerateTokenVectors(in: chunk.startIndex..<chunk.endIndex) { vec, _ in
                    for i in 0..<min(vec.count, sum.count) { sum[i] += vec[i] }
                    n += 1
                    return true
                }
            }
            let d = Double(max(n, 1))
            floats.append(contentsOf: sum.map { Float32($0 / d) })
        }
        let data = floats.withUnsafeBufferPointer { Data(buffer: $0) }
        send(["id": id, "done": true, "dim": e.dimension, "vectors": data.base64EncodedString()])
    } catch {
        send(["id": id, "done": true, "error": "\(error)", "code": "embed"])
    }
}

// ---------- images: text (Live Text engine) and what's in the picture ----------
func image(_ id: Any, _ req: [String: Any]) {
    let path = req["path"] as? String ?? ""
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        send(["id": id, "done": true, "error": "Couldn't open the image", "code": "image"])
        return
    }
    let text = VNRecognizeTextRequest()
    text.recognitionLevel = .accurate
    text.usesLanguageCorrection = true
    let classify = VNClassifyImageRequest()
    do {
        try VNImageRequestHandler(cgImage: cg, options: [:]).perform([text, classify])
        let lines = (text.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        let labels = (classify.results ?? [])
            .filter { $0.confidence > 0.3 }
            .prefix(6)
            .map { $0.identifier.replacingOccurrences(of: "_", with: " ") }
        send(["id": id, "done": true, "text": lines.joined(separator: "\n"), "labels": Array(labels), "width": cg.width, "height": cg.height])
    } catch {
        send(["id": id, "done": true, "error": "\(error)", "code": "image"])
    }
}

func status(_ id: Any) {
    var llm = "available"
    if case .unavailable(let reason) = SystemLanguageModel.default.availability { llm = "\(reason)" }
    var embedState = "unavailable"
    if let e = embedder { embedState = e.hasAvailableAssets ? "available" : "downloading" }
    if let e = embedder, !e.hasAvailableAssets {
        Task { _ = try? await e.requestAssets() }
    }
    send(["id": id, "done": true, "llm": llm, "embed": embedState])
}

// ---------- Reminders (EventKit) ----------
let store = EKEventStore()
var watching = false

func accessName() -> String {
    switch EKEventStore.authorizationStatus(for: .reminder) {
    case .fullAccess: return "full"
    case .writeOnly: return "writeOnly"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

func watchReminders() {
    if watching { return }
    watching = true
    NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: nil) { _ in
        send(["event": "reminders-changed"])
    }
}

func reminderList(_ name: String) throws -> EKCalendar {
    if let existing = store.calendars(for: .reminder).first(where: { $0.title == name }) { return existing }
    let cal = EKCalendar(for: .reminder, eventStore: store)
    cal.title = name
    guard let source = store.defaultCalendarForNewReminders()?.source ?? store.sources.first(where: { $0.sourceType == .calDAV || $0.sourceType == .local }) else {
        throw NSError(domain: "tahoe", code: 1, userInfo: [NSLocalizedDescriptionKey: "No Reminders account to add a list to"])
    }
    cal.source = source
    try store.saveCalendar(cal, commit: true)
    return cal
}

func isoDay(_ c: DateComponents?) -> String {
    guard let c = c, let y = c.year, let m = c.month, let d = c.day else { return "" }
    return String(format: "%04d-%02d-%02d", y, m, d)
}

func remindersFetch(_ id: Any, _ req: [String: Any]) async {
    guard accessName() == "full" else {
        send(["id": id, "done": true, "error": "No access to Reminders", "code": "access"])
        return
    }
    do {
        let cal = try reminderList(req["list"] as? String ?? "Obsidian")
        let predicate = store.predicateForReminders(in: [cal])
        let items: [EKReminder] = await withCheckedContinuation { cont in
            store.fetchReminders(matching: predicate) { cont.resume(returning: $0 ?? []) }
        }
        let out: [[String: Any]] = items.map { r in
            [
                "id": r.calendarItemIdentifier,
                "title": r.title ?? "",
                "notes": r.notes ?? "",
                "url": r.url?.absoluteString ?? "",
                "due": isoDay(r.dueDateComponents),
                "completed": r.isCompleted,
                "modified": (r.lastModifiedDate ?? r.creationDate ?? Date()).timeIntervalSince1970 * 1000,
            ]
        }
        watchReminders()
        send(["id": id, "done": true, "items": out, "list": cal.calendarIdentifier])
    } catch {
        send(["id": id, "done": true, "error": "\(error.localizedDescription)", "code": "reminders"])
    }
}

func remindersSave(_ id: Any, _ req: [String: Any]) {
    guard accessName() == "full" else {
        send(["id": id, "done": true, "error": "No access to Reminders", "code": "access"])
        return
    }
    do {
        let cal = try reminderList(req["list"] as? String ?? "Obsidian")
        var ids: [String] = []
        for item in req["items"] as? [[String: Any]] ?? [] {
            var reminder: EKReminder
            if let rid = item["id"] as? String, !rid.isEmpty, let found = store.calendarItem(withIdentifier: rid) as? EKReminder {
                reminder = found
            } else {
                reminder = EKReminder(eventStore: store)
                reminder.calendar = cal
            }
            if let title = item["title"] as? String { reminder.title = title }
            if let notes = item["notes"] as? String { reminder.notes = notes }
            if let url = item["url"] as? String { reminder.url = url.isEmpty ? nil : URL(string: url) }
            if let due = item["due"] as? String {
                let parts = due.split(separator: "-").compactMap { Int($0) }
                reminder.dueDateComponents = parts.count == 3 ? DateComponents(year: parts[0], month: parts[1], day: parts[2]) : nil
            }
            if let done = item["completed"] as? Bool { reminder.isCompleted = done }
            try store.save(reminder, commit: false)
            ids.append(reminder.calendarItemIdentifier)
        }
        try store.commit()
        send(["id": id, "done": true, "ids": ids])
    } catch {
        store.reset()
        send(["id": id, "done": true, "error": "\(error.localizedDescription)", "code": "reminders"])
    }
}

// ---------- Calendar (read-only) ----------
func calendarAccessName() -> String {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .fullAccess: return "full"
    case .writeOnly: return "writeOnly"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

let isoDayParser: DateFormatter = {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    return f
}()

let isoStamp: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    f.timeZone = TimeZone.current
    return f
}()

func calendarEvents(_ id: Any, _ req: [String: Any]) {
    guard calendarAccessName() == "full" else {
        send(["id": id, "done": true, "error": "No access to Calendar", "code": "access"])
        return
    }
    guard let from = isoDayParser.date(from: req["from"] as? String ?? ""),
          let toDay = isoDayParser.date(from: req["to"] as? String ?? "") else {
        send(["id": id, "done": true, "error": "Bad dates", "code": "calendar"])
        return
    }
    let to = Calendar.current.date(byAdding: .day, value: 1, to: toDay) ?? toDay
    let calendars = store.calendars(for: .event)
    let events = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: calendars))
    let out: [[String: Any]] = events.sorted { $0.startDate < $1.startDate }.map { e in
        [
            "id": e.calendarItemIdentifier,
            "title": e.title ?? "",
            "start": isoStamp.string(from: e.startDate),
            "end": isoStamp.string(from: e.endDate),
            "allDay": e.isAllDay,
            "location": e.location ?? "",
            "calendar": e.calendar.title,
            "attendees": (e.attendees ?? []).compactMap { $0.name },
            "notes": String((e.notes ?? "").prefix(400)),
        ]
    }
    send(["id": id, "done": true, "events": out])
}

// ---------- main loop ----------
actor Tasks {
    var running: [String: Task<Void, Never>] = [:]
    func add(_ key: String, _ t: Task<Void, Never>) { running[key] = t }
    func remove(_ key: String) { running[key] = nil }
    func cancel(_ key: String) { running[key]?.cancel() }
}
let tasks = Tasks()
// The model runs one request at a time; embeddings and images queue behind each other.
let modelQueue = DispatchQueue(label: "model")
let workQueue = DispatchQueue(label: "work")

func handle(_ line: String) {
    guard let data = line.data(using: .utf8),
          let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
    let id = req["id"] ?? NSNull()
    let key = "\(id)"
    switch req["op"] as? String ?? "" {
    case "status":
        status(id)
    case "generate":
        let task = Task.detached {
            await generate(id, req)
            await tasks.remove(key)
        }
        Task { await tasks.add(key, task) }
    case "embed":
        workQueue.async { embed(id, req) }
    case "image":
        workQueue.async { image(id, req) }
    case "reminders.status":
        send(["id": id, "done": true, "access": accessName()])
    case "reminders.request":
        Task {
            _ = try? await store.requestFullAccessToReminders()
            send(["id": id, "done": true, "access": accessName()])
        }
    case "reminders.fetch":
        Task { await remindersFetch(id, req) }
    case "reminders.save":
        DispatchQueue.main.async { remindersSave(id, req) }
    case "calendar.status":
        send(["id": id, "done": true, "access": calendarAccessName()])
    case "calendar.request":
        Task {
            _ = try? await store.requestFullAccessToEvents()
            send(["id": id, "done": true, "access": calendarAccessName()])
        }
    case "calendar.events":
        DispatchQueue.main.async { calendarEvents(id, req) }
    case "cancel":
        let target = "\(req["target"] ?? "")"
        Task { await tasks.cancel(target) }
    default:
        send(["id": id, "done": true, "error": "Unknown op", "code": "op"])
    }
}

// Requests are read on a background thread; the main thread runs the run loop
// so EventKit can tell us when Reminders change.
Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) { handle(line) }
    exit(0)
}
dispatchMain()

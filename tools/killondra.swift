import AppKit
let apps = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == "com.ntars.ondra" }
for app in apps { app.forceTerminate() }

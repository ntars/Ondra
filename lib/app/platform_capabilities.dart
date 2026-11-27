import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform, kIsWeb;

/// Host abilities that the UI may use to decide whether a feature is visible.
///
/// The kernel's profile decides tool availability; these flags only cover
/// host integration that does not exist on every shell. Keeping the platform
/// checks here prevents product surfaces from growing their own `Platform.is*`
/// capability rules.
class OndraPlatformCapabilities {
  const OndraPlatformCapabilities({
    required this.embeddedBrowser,
    required this.credentialStore,
    required this.filePicker,
    required this.avatarPicker,
    required this.nativeNotifications,
    required this.localSubprocess,
    required this.localModel,
  });

  factory OndraPlatformCapabilities.current() {
    final platform = defaultTargetPlatform;
    final desktop =
        !kIsWeb &&
        (platform == TargetPlatform.macOS ||
            platform == TargetPlatform.windows ||
            platform == TargetPlatform.linux);
    return OndraPlatformCapabilities(
      embeddedBrowser:
          !kIsWeb &&
          (platform == TargetPlatform.macOS ||
              platform == TargetPlatform.windows ||
              platform == TargetPlatform.android),
      // The shell and kernel share DSH_HOME/.credentials.yaml on every IO
      // platform. A failed write is still reported by Keychain itself.
      credentialStore: !kIsWeb,
      filePicker:
          !kIsWeb &&
          (platform == TargetPlatform.macOS ||
              platform == TargetPlatform.windows),
      avatarPicker:
          !kIsWeb &&
          (platform == TargetPlatform.macOS ||
              platform == TargetPlatform.windows ||
              platform == TargetPlatform.android),
      nativeNotifications:
          !kIsWeb &&
          (platform == TargetPlatform.macOS ||
              platform == TargetPlatform.windows ||
              platform == TargetPlatform.android),
      localSubprocess:
          desktop || (!kIsWeb && platform == TargetPlatform.android),
      localModel: desktop,
    );
  }

  final bool embeddedBrowser;
  final bool credentialStore;
  final bool filePicker;
  final bool avatarPicker;
  final bool nativeNotifications;
  final bool localSubprocess;
  final bool localModel;
}

OndraPlatformCapabilities get ondraCapabilities =>
    OndraPlatformCapabilities.current();

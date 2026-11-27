import 'package:flutter/foundation.dart'
    show TargetPlatform, debugDefaultTargetPlatformOverride;
import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/platform_capabilities.dart';

void main() {
  tearDown(() => debugDefaultTargetPlatformOverride = null);

  test(
    'host capabilities are derived once instead of at each feature call site',
    () {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      final mac = ondraCapabilities;
      expect(mac.embeddedBrowser, isTrue);
      expect(mac.credentialStore, isTrue);
      expect(mac.filePicker, isTrue);
      expect(mac.avatarPicker, isTrue);
      expect(mac.nativeNotifications, isTrue);
      expect(mac.localSubprocess, isTrue);
      expect(mac.localModel, isTrue);

      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      final android = ondraCapabilities;
      expect(android.embeddedBrowser, isTrue);
      expect(android.credentialStore, isTrue);
      expect(android.filePicker, isFalse);
      expect(android.avatarPicker, isTrue);
      expect(android.nativeNotifications, isTrue);
      expect(android.localSubprocess, isTrue);
      expect(android.localModel, isFalse);

      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      final ios = ondraCapabilities;
      expect(ios.embeddedBrowser, isFalse);
      expect(ios.credentialStore, isTrue);
      expect(ios.filePicker, isFalse);
      expect(ios.avatarPicker, isFalse);
      expect(ios.localSubprocess, isFalse);
      expect(ios.localModel, isFalse);
    },
  );
}

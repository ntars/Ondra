/// 密钥写入的结论。两个实现共用。
library;

class KeychainSecret {
  const KeychainSecret({required this.ok, required this.message});

  final bool ok;
  final String message;
}

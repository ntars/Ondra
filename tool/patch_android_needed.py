#!/usr/bin/env python3
"""把 ELF 的 DT_NEEDED 里带版本号的库名改短（原地，dynstr 内覆盖）。

为什么要改：Termux 的 node 26 二进制 NEEDED 的是 libz.so.1 / libcrypto.so.3 /
libssl.so.3 / libicui18n.so.79 / libicuuc.so.79——而 Android 的 APK 打包规则
只收 `lib*.so` 结尾的文件（libz.so.1 这种进不了 APK）。这些库的无版本副本
（libz.so / libcrypto.so / …）我们已经放进 jniLibs，把 NEEDED 改短即可对上。

原理：DT_NEEDED 的名字存放在 .dynstr 字符串池里，linker 只认完整串。新名字
比旧名字短，直接在原位置覆盖 + 补 \\0 垫底，offset 不动，其他引用不受影响
（dynstr 里没有共享这些前缀的其他条目——Termux node 的池极简单，改完用
readelf/`strings` 复核一次 NEEDED 清单即可确认）。

用法：python3 tool/patch_android_needed.py <elf 路径>
依赖：pyelftools（mac: pip3 install pyelftools；CI ubuntu 自带或同装）。
"""
import sys

from elftools.elf.elffile import ELFFile

# 旧名 → 新名（必须更短，才能原地覆盖）。
REWRITES = {
    'libz.so.1': 'libz.so',
    'libcrypto.so.3': 'libcrypto.so',
    'libssl.so.3': 'libssl.so',
    'libicui18n.so.79': 'libicui18n.so',
    'libicuuc.so.79': 'libicuuc.so',
}


def main(path):
    with open(path, 'r+b') as f:
        elf = ELFFile(f)
        dynstr = elf.get_section_by_name('.dynstr')
        if dynstr is None:
            sys.exit('✗ 没有 .dynstr')
        dyn = elf.get_section_by_name('.dynamic')
        needed = [
            tag.needed
            for tag in dyn.iter_tags()
            if tag.entry.d_tag == 'DT_NEEDED'
        ]
        pool_off = dynstr['sh_offset']
        f.seek(pool_off)
        pool = bytearray(f.read(dynstr['sh_size']))
        changed = []
        for name in needed:
            new = REWRITES.get(name)
            if new is None:
                continue
            # 名字在池中的位置：需要完整字符串（含结尾 \\0），不是子串匹配。
            target = name.encode() + b'\x00'
            idx = bytes(pool).find(target)
            if idx < 0:
                sys.exit(f'✗ dynstr 里找不到 {name!r}（完整串）')
            # 覆盖为新名 + \\0；旧串剩余字节变成不可达的垃圾，无引用。
            pool[idx: idx + len(new.encode())] = new.encode()
            pool[idx + len(new.encode())] = 0
            changed.append(f'{name} → {new}')
        if not changed:
            print('无需修改（没有带版本号的 NEEDED）')
            return
        f.seek(pool_off)
        f.write(bytes(pool))
    # 复核：重读一次。
    with open(path, 'rb') as f:
        elf = ELFFile(f)
        dyn = elf.get_section_by_name('.dynamic')
        after = [t.needed for t in dyn.iter_tags() if t.entry.d_tag == 'DT_NEEDED']
    for line in changed:
        print(f'  {line}')
    bad = [n for n in after if n in REWRITES]
    if bad:
        sys.exit(f'✗ 改后仍有旧名：{bad}')
    print(f'✓ NEEDED 全部就位（{len(after)} 项）')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('用法: patch_android_needed.py <elf>')
    main(sys.argv[1])

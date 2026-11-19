/// Web 预览没有文件存储。null 表示未保存过，区别于用户保存的空数组。
List<Map<String, String>>? loadBrowserSites() => null;

void saveBrowserSites(List<Map<String, String>> sites) {}

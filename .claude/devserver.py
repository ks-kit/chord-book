# コード帳 用の簡易サーバ
#   python devserver.py 8766        … このPCだけ（127.0.0.1）
#   python devserver.py 8766 --lan  … 同じWi-Fiの他端末からも見えるようにする
#
# ブラウザにキャッシュさせないので、コードを直した結果がそのまま反映される。
#
# ⚠ 必ず ThreadingHTTPServer を使う。
#   socketserver.TCPServer だとリクエストを1件ずつしか処理せず、
#   ブラウザが接続を掴んだまま待つだけで全体が固まる（2026-09-12 に発生）。
import http.server
import socket
import sys
import os


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'      # 接続を使い回して往復を減らす

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass                            # アクセスログは出さない


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except Exception:
        return '127.0.0.1'
    finally:
        s.close()


# このファイルの1つ上（アプリ本体のフォルダ）を公開する
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

port = 8766
lan = '--lan' in sys.argv
for a in sys.argv[1:]:
    if a.isdigit():
        port = int(a)

host = '0.0.0.0' if lan else '127.0.0.1'

with Server((host, port), Handler) as httpd:
    print('-' * 52)
    print('  コード帳を起動しました')
    print('  このPC     : http://localhost:%d/' % port)
    if lan:
        print('  iPhone等   : http://%s:%d/   （同じWi-Fi）' % (lan_ip(), port))
    print('  終わるとき : この窓を閉じる（または Ctrl+C）')
    print('-' * 52, flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass

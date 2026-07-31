import os, re
files = ["public/blackjack.html", "public/poker.html", "public/roulette.html", "public/bluff.html", "public/teenpatti.html"]
for fpath in files:
    if not os.path.exists(fpath): continue
    with open(fpath, "r", encoding="utf-8") as f:
        content = f.read()

    # Remove the chatRoomName update line
    content = re.sub(r"document\.getElementById\('chatRoomName'\)\.innerText.*?;\n?", "", content)
    # Also remove any leftover chat things just in case
    content = re.sub(r"document\.getElementById\('chatRoomName'\).*?;\n?", "", content)

    with open(fpath, "w", encoding="utf-8") as f:
        f.write(content)


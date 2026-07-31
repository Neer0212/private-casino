import os, re
files = ["public/blackjack.html", "public/poker.html", "public/roulette.html", "public/bluff.html", "public/teenpatti.html"]
for fpath in files:
    if not os.path.exists(fpath): continue
    with open(fpath, "r", encoding="utf-8") as f:
        content = f.read()

    # Replace sidebar area
    content = re.sub(r"<div class=\"sidebar-area\">.*?class=\"chat-input-group\".*?</div>\s*</div>\s*</div>", "", content, flags=re.DOTALL)

    # Replace chat javascript
    content = re.sub(r"function sendChat\(\).*?hist\.scrollTop = hist\.scrollHeight;\n\s*}\);", "", content, flags=re.DOTALL)

    with open(fpath, "w", encoding="utf-8") as f:
        f.write(content)


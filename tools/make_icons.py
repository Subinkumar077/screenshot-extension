from PIL import Image, ImageDraw
import sys, os
out = sys.argv[1]
def make(size):
    S = 1024
    img = Image.new("RGBA", (S, S), (0,0,0,0))
    # gradient rounded square
    grad = Image.new("RGBA", (S, S))
    px = grad.load()
    c1 = (99, 102, 255); c2 = (139, 92, 246)
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2*S)
            px[x,y] = tuple(int(c1[i] + (c2[i]-c1[i])*t) for i in range(3)) + (255,)
    mask = Image.new("L", (S,S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0,0,S-1,S-1), radius=int(S*0.24), fill=255)
    img.paste(grad, (0,0), mask)
    d = ImageDraw.Draw(img)
    w = int(S*0.075); m = int(S*0.22); L = int(S*0.2)
    white = (255,255,255,255)
    # viewfinder corner brackets
    for (cx, cy, sx, sy) in [(m,m,1,1),(S-m,m,-1,1),(m,S-m,1,-1),(S-m,S-m,-1,-1)]:
        d.line([(cx, cy+sy*L), (cx, cy), (cx+sx*L, cy)], fill=white, width=w, joint="curve")
        d.ellipse((cx-w//2, cy-w//2, cx+w//2, cy+w//2), fill=white)
        d.ellipse((cx+sx*L-w//2, cy-w//2, cx+sx*L+w//2, cy+w//2), fill=white)
        d.ellipse((cx-w//2, cy+sy*L-w//2, cx+w//2, cy+sy*L+w//2), fill=white)
    # centre dot
    r = int(S*0.085)
    d.ellipse((S//2-r, S//2-r, S//2+r, S//2+r), fill=white)
    return img.resize((size,size), Image.LANCZOS)
os.makedirs(out, exist_ok=True)
for s in (16,32,48,128):
    make(s).save(os.path.join(out, f"icon{s}.png"))
print("ok")

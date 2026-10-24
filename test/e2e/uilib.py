import json, urllib.request
BASE='http://127.0.0.1:8099'
def get(path): return urllib.request.urlopen(BASE+path).read().decode()
errors=[]
def tgpage(browser, uid, w=390, h=844):
    mobile = w < 500
    ctx=browser.new_context(viewport={'width':w,'height':h}, device_scale_factor=2 if mobile else 1, has_touch=mobile, is_mobile=mobile)
    ctx.add_init_script("window.Telegram={WebApp:{initData:%s,ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},BackButton:{show(){},hide(){},onClick(){}},openLink(u){window.__opened=u},openTelegramLink(u){window.__opened=u}}};" % json.dumps(get(f'/__test/init?id={uid}')))
    pg=ctx.new_page()
    pg.on('console', lambda m: errors.append(('console',m.type,m.text)) if m.type in ('error','warning') else None)
    pg.on('pageerror', lambda e: errors.append(('pageerror',str(e))))
    return ctx,pg

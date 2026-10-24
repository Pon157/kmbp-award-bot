import sys, time; import os; sys.path.insert(0, os.path.dirname(__file__))
from uilib import *
from playwright.sync_api import sync_playwright
def shot(pg,n,full=False): pg.screenshot(path=f'/tmp/kmbp-shots/{n}.png', full_page=full)
def toasts(pg): return pg.locator('.toast').all_inner_texts()
def vote_card(pg, idx=0, label='Проголосовать'):
    pg.wait_for_selector('.pcard'); pg.wait_for_timeout(3300)
    pg.locator('.pcard').nth(idx).get_by_text(label, exact=True).first.click()
    pg.wait_for_selector('.sheet'); pg.click('.sheet__actions .btn--gold'); pg.wait_for_timeout(500)
    if pg.locator('.captcha img').count():
        pg.fill('.sheet input', get('/__test/lastcaptcha')); pg.click('.sheet .btn--gold')
    pg.wait_for_selector('.is-mine', timeout=6000); pg.wait_for_timeout(300)
with sync_playwright() as p:
    b=p.chromium.launch()
    ctx,pg=tgpage(b,2004)
    pg.goto(BASE+'/'); pg.wait_for_selector('.hero')
    pg.click('text=Начать голосовать'); vote_card(pg)
    # меню
    pg.click('.burger'); pg.wait_for_selector('.drawer'); pg.wait_for_timeout(300); shot(pg,'20_menu')
    pg.click('text=Поменять голос'); pg.wait_for_selector('.card'); pg.wait_for_timeout(300); shot(pg,'21_change')
    pg.go_back(); pg.wait_for_timeout(600)
    pg.click('.burger'); pg.click('text=Отдать дополнительный голос'); pg.wait_for_selector('.hero'); pg.wait_for_timeout(300); shot(pg,'22_extra')
    pg.get_by_text('Выбрать проект').first.click(); pg.wait_for_selector('.pcard'); pg.wait_for_timeout(3400)
    pg.locator('.pcard').nth(1).get_by_text('Отдать +0,5', exact=False).click()
    pg.wait_for_selector('.sheet'); shot(pg,'23_extra_confirm'); pg.click('.sheet__actions .btn--gold'); pg.wait_for_timeout(900)
    print('extra toasts:', toasts(pg)); shot(pg,'24_extra_done')
    pg.go_back(); pg.wait_for_timeout(700); print('after extra balance text:', pg.locator('.hero .h1').inner_text())
    # рисование
    pg.click('.burger'); pg.click('text=Нарисовать рисунок'); pg.wait_for_selector('.paint__cv'); pg.wait_for_timeout(400)
    pg.locator('.chip', has_text='Проект года').click(); pg.wait_for_timeout(500)
    pg.locator('.field').nth(1).locator('.chip').nth(1).click()
    box=pg.locator('.paint__cv').bounding_box()
    pg.locator('.sw').nth(2).click()
    pg.mouse.move(box['x']+40,box['y']+40); pg.mouse.down(); 
    for i in range(1,12): pg.mouse.move(box['x']+40+i*15, box['y']+40+(i%3)*40)
    pg.mouse.up()
    pg.locator('.sw').nth(9).click(); pg.locator('.sz').nth(3).click()
    pg.mouse.move(box['x']+60,box['y']+200); pg.mouse.down(); pg.mouse.move(box['x']+200,box['y']+260); pg.mouse.up()
    pg.wait_for_timeout(200); shot(pg,'25_draw')
    pg.get_by_text('Оставить рисунок', exact=True).click(); pg.wait_for_timeout(1200); print('draw toasts:', toasts(pg))
    # галерея на карточке
    pg.go_back() if pg.locator('.paint__cv').count() else None
    pg.click('.burger'); pg.click('text=Форум'); pg.wait_for_selector('.topic'); pg.locator('.topic').first.click(); pg.wait_for_selector('.composer'); pg.wait_for_timeout(400)
    pg.fill('.composer textarea','Привет всем! Я за Мир ботов'); pg.click('.composer .btn--gold'); pg.wait_for_timeout(1200); print('post toasts:', toasts(pg), 'msgs', pg.locator('.msg').count())
    pg.wait_for_timeout(6500)
    pg.fill('.composer textarea','Заходи на https://spam.example.com'); pg.click('.composer .btn--gold'); pg.wait_for_timeout(900); print('spam toast:', toasts(pg))
    shot(pg,'31_forum')
    pg.locator('.msg').first.get_by_text('Ответить').click(); pg.wait_for_timeout(300); shot(pg,'32_reply')
    print(errors)
    b.close()

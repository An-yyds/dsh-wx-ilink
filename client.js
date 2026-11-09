/* DSH Web 客户端：右上角微信图标（状态点）+ 原生右侧抽屉（扫码/联系人/人设）。 */
window.__ModuleLoader__.load({
  id: 'dsh-wx-ilink',
  factory: (require) => {
    'use strict'

    var module = { exports: {} }
    var React = require('react')
    var h = React.createElement
    var useEffect = React.useEffect
    var useState = React.useState

    var open = false
    var listeners = new Set()

    function setOpen(next) {
      open = next
      listeners.forEach(function (listener) { listener(open) })
    }

    function useOpen() {
      var force = React.useReducer(function (value) { return value + 1 }, 0)[1]
      useEffect(function () {
        listeners.add(force)
        return function () { listeners.delete(force) }
      }, [force])
      return open
    }

    function WeixinIcon() {
      return h('svg', {
        width: 18,
        height: 18,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false'
      }, [
        h('path', {
          key: 'bubble',
          d: 'M9.6 4.2c-3.7 0-6.7 2.4-6.7 5.4 0 1.7.9 3.2 2.4 4.2l-.6 2 2.3-1.1c.8.2 1.7.3 2.6.3.2 0 .5 0 .7-.1-.2-.5-.3-1-.3-1.6 0-3 3.1-5.4 6.9-5.4.3 0 .7 0 1 .1-.9-2.2-3.4-3.8-6.3-3.8Z',
          fill: 'currentColor'
        }),
        h('path', {
          key: 'bubble2',
          d: 'M17.9 9.2c-3.1 0-5.6 2-5.6 4.5s2.5 4.5 5.6 4.5c.7 0 1.4-.1 2-.3l1.9.9-.5-1.7c1.2-.8 1.9-2 1.9-3.4 0-2.5-2.4-4.5-5.3-4.5Z',
          fill: 'currentColor',
          opacity: 0.72
        })
      ])
    }

    function HeaderButton() {
      var isOpen = useOpen()
      var badgeState = useState(null)
      var badge = badgeState[0]
      var setBadge = badgeState[1]
      useEffect(function () {
        var alive = true
        function tick() {
          jsonFetch('/weixin/status')
            .then(function (data) { if (alive) setBadge(!!data.connected) })
            .catch(function () { if (alive) setBadge(false) })
        }
        tick()
        var timer = setInterval(tick, 5000)
        return function () { alive = false; clearInterval(timer) }
      }, [])
      return h('button', {
        type: 'button',
        title: '微信',
        'aria-label': '微信',
        'aria-expanded': isOpen ? 'true' : 'false',
        onClick: function () { setOpen(!open) },
        style: {
          width: '28px',
          height: '28px',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          border: 0,
          borderRadius: '7px',
          background: isOpen ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          cursor: 'pointer',
          position: 'relative'
        }
      }, [
        h(WeixinIcon, { key: 'icon' }),
        h('span', {
          key: 'badge',
          style: {
            position: 'absolute',
            right: '2px',
            bottom: '2px',
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: badge === null
              ? 'var(--dsw-alias-state-idle-primary)'
              : badge ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)',
            border: '1px solid var(--dsw-alias-bg-base)'
          }
        })
      ])
    }

    var muted = { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.5 }
    var cardStyle = {
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '10px',
      padding: '12px',
      background: 'var(--dsw-alias-bg-layer-1)'
    }
    var inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: '8px',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      padding: '9px 10px',
      font: 'inherit',
      outline: 'none'
    }
    var primaryButton = {
      border: 0,
      borderRadius: '8px',
      padding: '9px 14px',
      background: 'var(--dsw-alias-brand-primary)',
      color: '#fff',
      font: 'inherit',
      fontWeight: 600,
      cursor: 'pointer'
    }
    var secondaryButton = {
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: '8px',
      padding: '8px 12px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      cursor: 'pointer'
    }

    function jsonFetch(url, options) {
      return fetch(url, Object.assign({ cache: 'no-store' }, options || {})).then(function (response) {
        return response.json().catch(function () { return {} }).then(function (data) {
          if (!response.ok) throw new Error((data && data.error) || ('HTTP ' + response.status))
          return data
        })
      })
    }

    function Drawer() {
      var isOpen = useOpen()
      var statusState = useState(null)
      var status = statusState[0]
      var setStatus = statusState[1]
      var contactsState = useState([])
      var contacts = contactsState[0]
      var setContacts = contactsState[1]
      var selectedState = useState('')
      var selected = selectedState[0]
      var setSelected = selectedState[1]
      var personaState = useState('')
      var persona = personaState[0]
      var setPersona = personaState[1]
      var customState = useState(false)
      var custom = customState[0]
      var setCustom = customState[1]
      var codeState = useState('')
      var code = codeState[0]
      var setCode = codeState[1]
      var busyState = useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      var errorState = useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var noticeState = useState('')
      var notice = noticeState[0]
      var setNotice = noticeState[1]

      function loadStatus() {
        jsonFetch('/weixin/status')
          .then(function (data) { setStatus(data); setError('') })
          .catch(function (err) { setError(err.message || String(err)) })
      }

      function loadContacts() {
        jsonFetch('/weixin/contacts')
          .then(function (data) {
            var list = data.contacts || []
            setContacts(list)
            if (!selected && list.length) setSelected(list[0].id)
          })
          .catch(function () {})
      }

      function loadPersona(peer) {
        if (!peer) { setPersona(''); setCustom(false); return }
        jsonFetch('/weixin/persona?peer=' + encodeURIComponent(peer))
          .then(function (data) { setPersona(data.persona || ''); setCustom(!!data.custom) })
          .catch(function () {})
      }

      useEffect(function () {
        if (!isOpen) return undefined
        loadStatus()
        loadContacts()
        var timer = setInterval(function () { loadStatus(); loadContacts() }, 2000)
        return function () { clearInterval(timer) }
      }, [isOpen])

      useEffect(function () {
        if (isOpen) loadPersona(selected)
      }, [isOpen, selected])

      useEffect(function () {
        if (!isOpen) return undefined
        function onKey(event) { if (event.key === 'Escape') setOpen(false) }
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('keydown', onKey) }
      }, [isOpen])

      if (!isOpen) return null
      var connected = !!(status && status.connected)
      var hasQr = !!(status && status.hasQr)
      var needCode = !!(status && status.needCode)
      var stateText = status ? status.stateText : '加载中…'

      function submitCode() {
        if (!code.trim() || busy) return
        setBusy('verify')
        jsonFetch('/weixin/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: code.trim() })
        }).then(function () { setCode(''); setNotice('验证码已提交'); loadStatus() })
          .catch(function (err) { setError(err.message || String(err)) })
          .finally(function () { setBusy('') })
      }

      function doLogin() {
        if (busy) return
        setBusy('login')
        jsonFetch('/weixin/login', { method: 'POST' })
          .then(function () { setNotice('已开始新的扫码登录'); loadStatus() })
          .catch(function (err) { setError(err.message || String(err)) })
          .finally(function () { setBusy('') })
      }

      function doLogout() {
        if (busy || !window.confirm('确定退出当前微信登录？')) return
        setBusy('logout')
        jsonFetch('/weixin/logout', { method: 'POST' })
          .then(function () { setNotice('已退出登录'); setContacts([]); loadStatus() })
          .catch(function (err) { setError(err.message || String(err)) })
          .finally(function () { setBusy('') })
      }

      function savePersona(text) {
        if (!selected || busy) return
        setBusy('persona')
        jsonFetch('/weixin/persona', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ peer: selected, text: text })
        }).then(function (data) {
          setPersona(data.persona || '')
          setCustom(!!data.custom)
          setNotice(text ? '人设已保存，下一条消息生效' : '已恢复默认人设')
          loadContacts()
        }).catch(function (err) { setError(err.message || String(err)) })
          .finally(function () { setBusy('') })
      }

      var body = []
      if (error) body.push(h('div', { key: 'error', role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', marginBottom: '10px', wordBreak: 'break-word' } }, error))
      if (notice && !error) body.push(h('div', { key: 'notice', role: 'status', style: { color: 'var(--dsw-alias-state-success-primary)', fontSize: '12px', marginBottom: '10px' } }, notice))
      body.push(h('div', { key: 'summary', style: cardStyle }, [
        h('div', { key: 'state', style: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 } }, [
          h('span', { key: 'dot', style: { width: '8px', height: '8px', borderRadius: '50%', background: connected ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)' } }),
          h('span', { key: 'text' }, stateText)
        ]),
        h('div', { key: 'msg', style: Object.assign({ marginTop: '6px' }, muted) }, status ? status.message : '正在读取微信状态…'),
        connected ? h('div', { key: 'meta', style: Object.assign({ marginTop: '6px' }, muted) }, '机器人：' + (status.botId || '未知') + ' · 联系人会话：' + status.sessions + ' · 审批等待：' + status.approvals) : null
      ]))

      if (!connected) {
        if (hasQr) {
          body.push(h('div', { key: 'qr', style: { display: 'flex', justifyContent: 'center', margin: '14px 0 6px' } },
            h('img', { src: '/weixin/qr.svg?ts=' + status.qrAt, alt: '微信登录二维码', style: { width: '240px', height: '240px', background: '#fff', borderRadius: '10px', padding: '8px' } })))
        }
        if (needCode) {
          body.push(h('div', { key: 'code', style: { display: 'flex', gap: '8px', marginTop: '8px' } }, [
            h('input', { key: 'input', value: code, inputMode: 'numeric', placeholder: '手机微信上的数字验证码', onChange: function (event) { setCode(event.target.value) }, onKeyDown: function (event) { if (event.key === 'Enter') submitCode() }, style: inputStyle }),
            h('button', { key: 'submit', type: 'button', onClick: submitCode, disabled: !!busy, style: primaryButton }, '提交')
          ]))
        }
        body.push(h('div', { key: 'actions', style: { display: 'flex', gap: '8px', marginTop: '14px' } }, [
          h('button', { key: 'login', type: 'button', onClick: doLogin, disabled: !!busy, style: primaryButton }, busy === 'login' ? '正在获取…' : (hasQr ? '重新生成二维码' : '重新登录'))
        ]))
      } else {
        body.push(h('div', { key: 'contacts', style: { marginTop: '14px' } }, [
          h('div', { key: 'title', style: { fontWeight: 600, fontSize: '13px', marginBottom: '8px' } }, '联系人'),
          contacts.length
            ? h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, contacts.map(function (contact) {
              return h('button', {
                key: contact.id,
                type: 'button',
                onClick: function () { setSelected(contact.id) },
                style: Object.assign({}, secondaryButton, {
                  textAlign: 'left',
                  display: 'block',
                  width: '100%',
                  background: selected === contact.id ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                  borderColor: selected === contact.id ? 'var(--dsw-alias-border-l2)' : 'var(--dsw-alias-border-l1)'
                })
              }, [
                h('div', { key: 'name', style: { fontWeight: 600 } }, '微信用户 ' + contact.tail),
                h('div', { key: 'sid', style: Object.assign({ marginTop: '2px' }, muted) }, contact.sessionId || '')
              ])
            }))
            : h('div', { key: 'empty', style: muted }, '还没有联系人会话；让用户先发一条消息。')
        ]))

        body.push(h('div', { key: 'persona', style: Object.assign({ marginTop: '14px' }, cardStyle) }, [
          h('div', { key: 'title', style: { fontWeight: 600, fontSize: '13px', display: 'flex', justifyContent: 'space-between', gap: '8px' } }, [
            h('span', { key: 't' }, '人设'),
            h('span', { key: 's', style: muted }, custom ? '单独设置' : '默认')
          ]),
          h('textarea', {
            key: 'text',
            value: persona,
            rows: 5,
            placeholder: '例如：你叫大鲸鱼，性格温和幽默……',
            onChange: function (event) { setPersona(event.target.value) },
            style: Object.assign({ marginTop: '8px', resize: 'vertical', minHeight: '90px' }, inputStyle)
          }),
          h('div', { key: 'actions', style: { display: 'flex', gap: '8px', marginTop: '8px' } }, [
            h('button', { key: 'save', type: 'button', disabled: !selected || !!busy, onClick: function () { savePersona(persona) }, style: primaryButton }, busy === 'persona' ? '保存中…' : '保存人设'),
            h('button', { key: 'reset', type: 'button', disabled: !selected || !!busy, onClick: function () { savePersona('') }, style: secondaryButton }, '恢复默认')
          ]),
          h('div', { key: 'hint', style: Object.assign({ marginTop: '6px' }, muted) }, '人设只影响角色和语气，不改工具权限与事实。')
        ]))

        body.push(h('div', { key: 'actions', style: { display: 'flex', gap: '8px', marginTop: '14px' } }, [
          h('button', { key: 'relogin', type: 'button', onClick: doLogin, disabled: !!busy, style: secondaryButton }, '重新登录'),
          h('button', { key: 'logout', type: 'button', onClick: doLogout, disabled: !!busy, style: secondaryButton }, '退出登录')
        ]))
      }

      return h('div', { style: { position: 'fixed', inset: 0, zIndex: 1000, pointerEvents: 'none' } }, [
        h('div', {
          key: 'shade',
          onClick: function () { setOpen(false) },
          style: { position: 'absolute', inset: 0, background: 'rgba(15,23,42,.12)', pointerEvents: 'auto' }
        }),
        h('aside', {
          key: 'drawer',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'dsh-wx-ilink-title',
          style: {
            position: 'absolute',
            top: 0,
            right: 0,
            width: '420px',
            maxWidth: '100vw',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--dsw-alias-bg-base)',
            color: 'var(--dsw-alias-label-primary)',
            boxShadow: '-10px 0 28px rgba(15,23,42,.18)',
            pointerEvents: 'auto'
          }
        }, [
          h('div', {
            key: 'header',
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              padding: '14px 16px',
              borderBottom: '1px solid var(--dsw-alias-border-l1)'
            }
          }, [
            h('div', { key: 'title', id: 'dsh-wx-ilink-title', style: { fontSize: '15px', fontWeight: 600 } }, '微信'),
            h('button', {
              key: 'close',
              type: 'button',
              title: '关闭（Esc）',
              'aria-label': '关闭',
              onClick: function () { setOpen(false) },
              style: {
                width: '32px',
                height: '32px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                border: 0,
                borderRadius: '8px',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                cursor: 'pointer',
                fontSize: '22px',
                lineHeight: 1
              }
            }, '×')
          ]),
          h('div', { key: 'body', style: { flex: 1, overflowY: 'auto', padding: '14px 16px 20px' } }, body)
        ])
      ])
    }

    module.exports = {
      name: 'dsh-wx-ilink',
      inject: ['slots'],
      apply: function (ctx) {
        var stops = []
        try {
          stops.push(ctx.slots.inject('conversation.session.header.utilities', function () {
            return ctx.slots.register({
              name: 'conversation.session.header.utilities',
              id: 'weixin-ilink',
              order: 5,
              label: function () { return '微信' }
            }, HeaderButton)
          }))
          stops.push(ctx.slots.inject('shell.overlay', function () {
            return ctx.slots.register({
              name: 'shell.overlay',
              id: 'weixin-ilink',
              order: 90,
              label: function () { return '微信' }
            }, Drawer)
          }))
        } catch (error) {
          console.error('[dsh-wx-ilink] cannot register DSH slots', error)
        }
        ctx.effect(function () {
          return function () {
            stops.forEach(function (stop) { if (typeof stop === 'function') stop() })
            setOpen(false)
          }
        }, 'dsh-wx-ilink-client')
      }
    }

    return module.exports
  }
})

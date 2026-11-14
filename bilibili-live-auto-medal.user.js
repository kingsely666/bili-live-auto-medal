// ==UserScript==
// @name         B站直播｜粉丝牌面板 + 进房自动换牌
// @namespace    https://github.com/kingsely666/bili-live-auto-medal
// @version      2.4.0
// @description  点 B 站原生粉丝牌图标即可展开完整粉丝牌面板：全部徽章、头像、等级、亲密度进度、今日亲密度、佩戴中/当前房间/最近获得标记、点击切换、再点取消、滚动翻页、搜索、跳主播空间/直播间；并支持进直播间自动换上该主播的粉丝牌。设置项在直播页面内的设置窗口中修改，点「保存」后生效。全部直接调 B 站官方接口，不替换页面节点，B 站改版也不会失效。
// @author       WorkBuddy
// @match        *://live.bilibili.com/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_addValueChangeListener
// @grant        GM_setClipboard
// @connect      api.live.bilibili.com
// @license      MIT
// @noframes
// ==/UserScript==

/*
 * 设计要点（和旧版「b站直播徽章切换增强」的区别）：
 *   旧版是「藏掉 B 站原生勋章按钮、插入自己的面板，再借原生弹窗刷新状态」——B 站一改页面就整块失效。
 *   本版不读、不点、不修改 B 站任何原生勋章组件，全部自己实现：
 *     · 换牌/取消佩戴：直接 POST 官方 fansMedal/wear、fansMedal/take_off
 *     · 列表数据：直接 GET 官方 fansMedal/panel（分页 + special_list）
 *     · 当前佩戴 / 当前房间牌子 / 最近获得：全部从接口返回值判断
 *   入口接管原生粉丝牌图标：**不插节点、不替换原生按钮**，只在 document 捕获阶段拦 click，
 *   所以 Vue 重渲染抹不掉（旧脚本正是「替换原生节点」才被重渲染搞死）。
 *   mousedown 一律不碰 —— 拦了会让 B 站原生组件的按下/悬停状态错乱，表现为"原版功能不对"。
 *   面板贴屏幕右侧栏、底边停在输入框上方，不压播放器也不压输入框。
 *   想用原版弹窗时点面板里的「B站原版」，脚本放开拦截 15 秒并把原生图标高亮出来，
 *   再点一次即可（真实点击，行为与原版完全一致）；点进去后自动续到 60 秒，够把弹窗用完。
 *   原生图标改版找不到了，会自动退回一个悬浮小按钮兜底，保证永远进得去（Alt+M 始终可用）。
 *
 * 只读接口 + 只发「佩戴/取消佩戴」两个请求。不发弹幕、不送礼、不改页面业务逻辑。
 */

/*
 * 更新日志：
 *   2.4.0  设置改为网页内设置窗口，改动存草稿、点「保存」后生效；菜单固定 2 项；
 *          面板底部增加「设置」入口；默认牌支持下拉选择、用当前房间的牌子、清除
 *   2.3.1  「B站原版」放行 15 秒，命中后续到 60 秒；高亮持续到真正点到为止
 *   2.3.0  只拦 click；「B站原版」改两步真实点击；面板贴右侧、底边停在输入框上方
 *   2.2.1  修复原生按钮死键；处理面板打开失败；面板锚定原生按钮
 *   2.1.0  入口挂 body 并周期自检；补齐提示与诊断信息
 *   2.0.0  独立实现，官方接口直连，进房自动换牌 + 完整粉丝牌面板
 */

(function () {
  'use strict';

  // ==================== 配置 ====================
  const CFG_KEY = 'blam_cfg_v2';
  const DEFAULTS = {
    enabled: true,          // 进房自动换牌
    notify: true,           // 换成功后小提示
    fallbackDefault: false, // 没这个主播的牌子时切回默认牌
    defaultMedalId: 0,
    defaultMedalName: '',
    entryMode: 'native'     // native=接管原生粉丝牌图标 | float=悬浮小按钮 | both=两者都有
  };
  let cfg = Object.assign({}, DEFAULTS, loadCfg());

  function loadCfg() {
    try {
      // 从 v1 升级过来时沿用旧设置，不用重新配一遍
      const raw = (typeof GM_getValue === 'function')
        ? (GM_getValue(CFG_KEY, '') || GM_getValue('blam_cfg_v1', ''))
        : (localStorage.getItem(CFG_KEY) || localStorage.getItem('blam_cfg_v1'));
      return raw ? (JSON.parse(raw) || {}) : {};
    } catch (e) { return {}; }
  }
  function saveCfg() {
    try {
      const raw = JSON.stringify(cfg);
      if (typeof GM_setValue === 'function') GM_setValue(CFG_KEY, raw);
      else localStorage.setItem(CFG_KEY, raw);
    } catch (e) { /* ignore */ }
  }

  // ==================== 小工具 ====================
  function getCookie(name) {
    try {
      const parts = document.cookie.split(';');
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const k = p.indexOf('=');
        if (k < 0) continue;
        if (p.slice(0, k).trim() === name) {
          const v = p.slice(k + 1).trim();
          try { return decodeURIComponent(v); } catch (e) { return v; }
        }
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  function readRoomId() {
    const m = location.pathname.match(/^\/(?:blanc\/)?(\d+)/);
    if (m) return m[1];
    try {
      const q = new URLSearchParams(location.search).get('room_id');
      if (q && /^\d+$/.test(q)) return q;
    } catch (e) { /* ignore */ }
    return '';
  }

  function num(v) { const n = Number(v); return isFinite(n) && n > 0 ? n : 0; }
  function color(v, def) {
    if (v === undefined || v === null || v === '') return def;
    const n = Number(v);
    if (!isFinite(n) || n < 0) return def;
    return n;
  }
  function hex(n) { return ('000000' + Number(n).toString(16)).slice(-6); }
  function fmt(n) {
    n = Number(n) || 0;
    if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1) + '万';
    return String(n);
  }

  // B 站各版本返回结构兼容：递归找所有带 medal_id 的对象
  function collectMedals(root, out) {
    out = out || [];
    if (!root || typeof root !== 'object') return out;
    if (Array.isArray(root)) {
      for (let i = 0; i < root.length; i++) collectMedals(root[i], out);
      return out;
    }
    const medal = root.medal && typeof root.medal === 'object' ? root.medal : null;
    const anchor = root.anchor_info && typeof root.anchor_info === 'object' ? root.anchor_info : null;
    const id = num(root.medal_id) || (medal && num(medal.medal_id)) || 0;
    if (id) {
      out.push({
        id: id,
        name: String(root.medal_name || (medal && medal.medal_name) || root.target_name || root.uname || '粉丝牌'),
        anchor: String(root.target_name || root.uname || (anchor && anchor.nick_name) || ''),
        level: num(root.level) || (medal && num(medal.level)) || 0,
        targetId: num(root.target_id) || (medal && num(medal.target_id)) || (anchor && num(anchor.uid)) || num(root.uid) || 0,
        roomId: num(root.roomid) || num(root.room_id) || 0
      });
    }
    for (const k in root) {
      if (!Object.prototype.hasOwnProperty.call(root, k)) continue;
      const v = root[k];
      if (v && typeof v === 'object') collectMedals(v, out);
    }
    return out;
  }

  function uniqMedals(list) {
    const seen = new Set(), out = [];
    for (let i = 0; i < list.length; i++) {
      if (!seen.has(list[i].id)) { seen.add(list[i].id); out.push(list[i]); }
    }
    return out;
  }

  // ==================== 网络请求 ====================
  // 主通道用页面自带 fetch（和 B 站自己的请求一模一样，Origin/Referer 都正常）；
  // 万一被跨域或沙箱挡住，自动换 GM_xmlhttpRequest（它必定带 cookie）。
  function parseJson(text) {
    try { return JSON.parse(text); } catch (e) { throw new Error('返回不是 JSON：' + String(text).slice(0, 80)); }
  }

  function viaFetch(opt) {
    return new Promise(function (resolve, reject) {
      let ctl = null, timer = 0;
      const init = { method: opt.method || 'GET', credentials: 'include' };
      if (opt.body) {
        init.body = opt.body;
        init.headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json, text/plain, */*' };
      }
      if (typeof AbortController === 'function') {
        ctl = new AbortController();
        init.signal = ctl.signal;
        timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, 12000);
      }
      try {
        fetch(opt.url, init).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        }).then(function (t) {
          clearTimeout(timer);
          resolve(parseJson(t));
        }).catch(function (e) { clearTimeout(timer); reject(e); });
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  function viaGM(opt) {
    return new Promise(function (resolve, reject) {
      let settled = false;
      function ok(json) { if (!settled) { settled = true; resolve(json); } }
      function bad(err) { if (!settled) { settled = true; reject(err instanceof Error ? err : new Error(String(err))); } }
      try {
        GM_xmlhttpRequest({
          method: opt.method || 'GET',
          url: opt.url,
          headers: opt.body
            ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json, text/plain, */*' }
            : { 'Accept': 'application/json, text/plain, */*' },
          data: opt.body || undefined,
          timeout: 12000,
          onload: function (r) {
            if (r.status < 200 || r.status >= 300) { bad(new Error('HTTP ' + r.status)); return; }
            try { ok(parseJson(r.responseText)); } catch (e) { bad(e); }
          },
          onerror: function () { bad(new Error('网络请求失败')); },
          ontimeout: function () { bad(new Error('请求超时')); },
          onabort: function () { bad(new Error('请求被取消')); }
        });
      } catch (e) { bad(e); }
    });
  }

  function request(opt) {
    return viaFetch(opt).catch(function (err) {
      if (typeof GM_xmlhttpRequest === 'function') return viaGM(opt);
      throw err;
    });
  }
  function requestOtherChannel(opt) {
    return (typeof GM_xmlhttpRequest === 'function') ? viaGM(opt) : viaFetch(opt);
  }

  // 汉字 -> 拼音首字母（GB2312 一级常用字 3755 个，构建期生成，运行时零依赖、不联网）
  const PY_TABLE = {"a":"啊阿埃挨哎唉哀皑癌蔼矮艾碍爱隘鞍氨安俺按暗岸胺案肮昂盎凹敖熬翱袄傲奥懊澳嚣","b":"芭捌扒叭吧笆八疤巴拔跋靶把坝霸罢爸白柏百摆佰败拜稗斑班搬扳般颁板版扮拌伴瓣半办绊邦帮梆榜膀绑棒磅蚌镑傍谤苞胞包褒剥薄雹保堡饱宝抱报暴豹鲍爆杯碑悲卑北辈背贝钡倍狈备惫焙被奔苯本笨崩绷甭泵蹦迸逼鼻比鄙笔彼碧蓖蔽毕毙毖币庇痹闭敝弊必壁臂避陛鞭边编贬扁便变卞辨辩辫遍标彪膘表鳖憋别瘪彬斌濒滨宾摈兵冰柄丙秉饼炳病并玻菠播拨钵波博勃搏铂箔伯帛舶脖膊渤泊驳捕卜哺补埠不布步簿部怖","c":"擦猜裁材才财睬踩采彩菜蔡餐参蚕残惭惨灿苍舱仓沧藏操糙槽曹草厕策侧册测层蹭插叉茬茶查碴搽察岔差诧拆柴豺搀掺蝉馋谗缠铲产阐颤昌猖场尝常长偿肠厂敞畅唱倡超抄钞朝嘲潮巢吵炒车扯撤掣彻澈郴臣辰尘晨忱沉陈趁衬撑称城橙成呈乘程惩澄诚承逞骋秤吃痴持匙池迟弛驰耻齿侈尺赤翅斥炽充冲虫崇宠抽酬畴踌稠愁筹仇绸瞅丑臭初出橱厨躇锄雏滁除楚础储矗搐触处揣川穿椽传船喘串疮窗床闯创吹炊捶锤垂春椿醇唇淳纯蠢戳绰疵茨磁雌辞慈瓷词此刺赐次聪葱囱匆从丛凑粗醋簇促蹿篡窜摧崔催脆瘁粹淬翠村存寸磋撮搓措挫错刹畜曾","d":"搭达答瘩打大呆歹傣戴带殆代贷袋待逮怠耽担丹单郸掸胆旦氮但惮淡诞蛋当挡党荡档刀捣蹈倒岛祷导到稻悼道盗德得的蹬灯登等瞪凳邓堤低滴迪敌笛狄涤嫡抵底地蒂第帝弟递缔颠掂滇碘点典靛垫电佃甸店惦奠淀殿碉叼雕凋刁掉吊钓跌爹碟蝶迭谍叠丁盯叮钉顶鼎锭定订丢东冬董懂动栋侗恫冻洞兜抖斗陡豆逗痘都督毒犊独读堵睹赌杜镀肚度渡妒端短锻段断缎堆兑队对墩吨蹲敦顿钝盾遁掇哆多夺垛躲朵跺舵剁惰堕","e":"蛾峨鹅俄额讹娥恶厄扼遏鄂饿恩而儿耳尔饵洱二贰","f":"发罚筏伐乏阀法珐藩帆番翻樊矾钒繁凡烦反返范贩犯饭泛坊芳方肪房防妨仿访纺放菲非啡飞肥匪诽吠肺废沸费芬酚吩氛分纷坟焚汾粉奋份忿愤粪丰封枫蜂峰锋风疯烽逢冯缝讽奉凤佛否夫敷肤孵扶拂辐幅氟符伏俘服浮涪福袱弗甫抚辅俯釜斧腑府腐赴副覆赋复傅付阜父腹负富讣附妇缚咐","g":"噶嘎该改概钙盖溉干甘杆柑竿肝赶感秆敢赣冈刚钢缸肛纲岗港杠篙皋高膏羔糕搞稿告哥歌搁戈鸽胳疙割革葛格阁隔铬个各给根跟耕更庚羹埂耿梗工攻功恭龚供躬公宫弓巩汞拱贡共钩勾沟苟狗垢构购够辜菇咕箍估沽孤姑鼓古蛊骨谷股故顾固雇刮瓜剐寡挂褂乖拐怪棺关官冠观管馆罐惯灌贯光广逛瑰规圭硅归龟闺轨鬼诡癸桂柜跪贵刽辊滚棍锅郭国果裹过咯","h":"镐蛤哈骸孩海氦亥害骇酣憨邯韩含涵寒函喊罕翰撼捍旱憾悍焊汗汉夯杭航壕嚎豪毫郝好耗号浩呵喝荷菏核禾和何合盒阂河涸赫褐鹤贺嘿黑痕很狠恨哼亨横衡恒轰哄烘虹鸿洪宏弘红喉侯猴吼厚候后呼乎忽瑚壶葫胡蝴狐糊湖弧虎唬护互沪户花哗华猾滑画划化话槐徊怀淮坏欢环桓还缓换患唤痪豢焕涣宦幻荒慌黄磺蝗簧皇凰惶煌晃幌恍谎灰挥辉徽恢蛔回毁悔慧卉惠晦贿秽会烩汇讳诲绘荤昏婚魂浑混豁活伙火获或惑霍货祸咳","j":"击圾基机畸稽积箕肌饥迹激讥鸡姬绩缉吉极棘辑籍集及急疾汲即嫉级挤几脊己蓟技冀季伎祭剂悸济寄寂计记既忌际妓继纪嘉枷夹佳家加荚颊贾甲钾假稼价架驾嫁歼监坚尖笺间煎兼肩艰奸缄茧检柬碱硷拣捡简俭剪减荐鉴践贱见键箭件健舰剑饯渐溅涧建僵姜将浆江疆蒋桨奖讲匠酱降蕉椒礁焦胶交郊浇骄娇嚼搅铰矫侥脚狡角饺缴绞剿教酵轿较叫窖揭接皆秸街阶截劫节桔杰捷睫竭洁结解姐戒藉芥界借介疥诫届巾筋斤金今津襟紧锦仅谨进靳晋禁近烬浸尽劲荆兢茎睛晶鲸京惊精粳经井警景颈静境敬镜径痉靖竟竞净炯窘揪究纠玖韭久灸九酒厩救旧臼舅咎就疚鞠拘狙疽居驹菊局矩举沮聚拒据巨具距踞锯俱句惧炬剧捐鹃娟倦眷卷绢撅攫抉掘倔爵觉决诀绝均菌钧军君峻俊竣浚郡骏","k":"槛喀咖卡开揩楷凯慨刊堪勘坎砍看康慷糠扛抗亢炕考拷烤靠坷苛柯棵磕颗科壳可渴克刻客课肯啃垦恳坑吭空恐孔控抠口扣寇枯哭窟苦酷库裤夸垮挎跨胯块筷侩快宽款匡筐狂框矿眶旷况亏盔岿窥葵奎魁傀馈愧溃坤昆捆困括扩廓阔","l":"垃拉喇蜡腊辣啦莱来赖蓝婪栏拦篮阑兰澜谰揽览懒缆烂滥琅榔狼廊郎朗浪捞劳牢老佬姥酪烙涝勒乐雷镭蕾磊累儡垒擂肋类泪棱楞冷厘梨犁黎篱狸离漓理李里鲤礼莉荔吏栗丽厉励砾历利傈例俐痢立粒沥隶力璃哩俩联莲连镰廉怜涟帘敛脸链恋炼练粮凉梁粱良两辆量晾亮谅撩聊僚疗燎寥辽潦了撂镣廖料列裂烈劣猎琳林磷霖临邻鳞淋凛赁吝拎玲菱零龄铃伶羚凌灵陵岭领另令溜琉榴硫馏留刘瘤流柳六龙聋咙笼窿隆垄拢陇楼娄搂篓漏陋芦卢颅庐炉掳卤虏鲁麓碌露路赂鹿潞禄录陆戮驴吕铝侣旅履屡缕虑氯律率滤绿峦挛孪滦卵乱掠略抡轮伦仑沦纶论萝螺罗逻锣箩骡裸落洛骆络","m":"貉妈麻玛码蚂马骂嘛吗埋买麦卖迈脉瞒馒蛮满蔓曼慢漫谩芒茫盲氓忙莽猫茅锚毛矛铆卯茂冒帽貌贸么玫枚梅酶霉煤没眉媒镁每美昧寐妹媚门闷们萌蒙檬盟锰猛梦孟眯醚靡糜迷谜弥米秘觅泌蜜密幂棉眠绵冕免勉娩缅面苗描瞄藐秒渺庙妙蔑灭民抿皿敏悯闽明螟鸣铭名命谬摸摹蘑模膜磨摩魔抹末莫墨默沫漠寞陌谋牟某拇牡亩姆母墓暮幕募慕木目睦牧穆","n":"拿哪呐钠那娜纳氖乃奶耐奈南男难囊挠脑恼闹淖呢馁内嫩能妮霓倪泥尼拟你匿腻逆溺蔫拈年碾撵捻念娘酿鸟尿捏聂孽啮镊镍涅您柠狞凝宁拧泞牛扭钮纽脓浓农弄奴努怒女暖虐疟挪懦糯诺粘辗","o":"哦欧鸥殴藕呕偶沤","p":"耙辟脯啪趴爬帕怕琶拍排牌徘湃派攀潘盘磐盼畔判叛乓庞旁耪胖抛咆刨炮袍跑泡呸胚培裴赔陪配佩沛喷盆砰抨烹澎彭蓬棚硼篷膨朋鹏捧碰坯砒霹批披劈琵毗啤脾疲皮匹痞僻屁譬篇偏片骗飘漂瓢票撇瞥拼频贫品聘乒坪苹萍平凭瓶评屏坡泼颇婆破魄迫粕剖扑铺仆莆葡菩蒲埔朴圃普浦谱曝瀑","q":"期欺栖戚妻七凄漆柒沏其棋奇歧畦崎脐齐旗祈祁骑起岂乞企启契砌器气迄弃汽泣讫掐恰洽牵扦钎铅千迁签仟谦乾黔钱钳前潜遣浅谴堑嵌欠歉枪呛腔羌墙蔷强抢橇锹敲悄桥瞧乔侨巧鞘撬翘峭俏窍切茄且怯窃钦侵亲秦琴勤芹擒禽寝沁青轻氢倾卿清擎晴氰情顷请庆琼穷秋丘邱球求囚酋泅趋区蛆曲躯屈驱渠取娶龋趣去圈颧权醛泉全痊拳犬券劝缺炔瘸却鹊榷确雀裙群","r":"然燃冉染瓤壤攘嚷让饶扰绕惹热壬仁人忍韧任认刃妊纫扔仍日戎茸蓉荣融熔溶容绒冗揉柔肉茹蠕儒孺如辱乳汝入褥软阮蕊瑞锐闰润若弱","s":"撒洒萨腮鳃塞赛三叁伞散桑嗓丧搔骚扫嫂瑟色涩森僧莎砂杀沙纱傻啥煞筛晒珊苫杉山删煽衫闪陕擅赡膳善汕扇缮墒伤商赏晌上尚裳梢捎稍烧芍勺韶少哨邵绍奢赊蛇舌舍赦摄射慑涉社设砷申呻伸身深娠绅神沈审婶甚肾慎渗声生甥牲升绳省盛剩胜圣师失狮施湿诗尸虱十石拾时什食蚀实识史矢使屎驶始式示士世柿事拭誓逝势是嗜噬适仕侍释饰氏市恃室视试收手首守寿授售受瘦兽蔬枢梳殊抒输叔舒淑疏书赎孰熟薯暑曙署蜀黍鼠属术述树束戍竖墅庶数漱恕刷耍摔衰甩帅栓拴霜双爽谁水睡税吮瞬顺舜说硕朔烁斯撕嘶思私司丝死肆寺嗣四伺似饲巳松耸怂颂送宋讼诵搜艘擞嗽苏酥俗素速粟僳塑溯宿诉肃酸蒜算虽隋随绥髓碎岁穗遂隧祟孙损笋蓑梭唆缩琐索锁所厦栅","t":"弹调囤塌他它她塔獭挞蹋踏胎苔抬台泰酞太态汰坍摊贪瘫滩坛檀痰潭谭谈坦毯袒碳探叹炭汤塘搪堂棠膛唐糖倘躺淌趟烫掏涛滔绦萄桃逃淘陶讨套特藤腾疼誊梯剔踢锑提题蹄啼体替嚏惕涕剃屉天添填田甜恬舔腆挑条迢眺跳贴铁帖厅听烃汀廷停亭庭挺艇通桐酮瞳同铜彤童桶捅筒统痛偷投头透凸秃突图徒途涂屠土吐兔湍团推颓腿蜕褪退吞屯臀拖托脱鸵陀驮驼椭妥拓唾","w":"挖哇蛙洼娃瓦袜歪外豌弯湾玩顽丸烷完碗挽晚皖惋宛婉万腕汪王亡枉网往旺望忘妄威巍微危韦违桅围唯惟为潍维苇萎委伟伪尾纬未蔚味畏胃喂魏位渭谓尉慰卫瘟温蚊文闻纹吻稳紊问嗡翁瓮挝蜗涡窝我斡卧握沃巫呜钨乌污诬屋无芜梧吾吴毋武五捂午舞伍侮坞戊雾晤物勿务悟误","x":"昔熙析西硒矽晰嘻吸锡牺稀息希悉膝夕惜熄烯溪汐犀檄袭席习媳喜铣洗系隙戏细瞎虾匣霞辖暇峡侠狭下夏吓掀锨先仙鲜纤咸贤衔舷闲涎弦嫌显险现献县腺馅羡宪陷限线相厢镶香箱襄湘乡翔祥详想响享项巷橡像向象萧硝霄削哮销消宵淆晓小孝校肖啸笑效楔些歇蝎鞋协挟携邪斜胁谐写械卸蟹懈泄泻谢屑薪芯锌欣辛新忻心信衅星腥猩惺兴刑型形邢行醒幸杏性姓兄凶胸匈汹雄熊休修羞朽嗅锈秀袖绣墟戌需虚嘘须徐许蓄酗叙旭序恤絮婿绪续轩喧宣悬旋玄选癣眩绚靴薛学穴雪血勋熏循旬询寻驯巡殉汛训讯逊迅吁","y":"压押鸦鸭呀丫芽牙蚜崖衙涯雅哑亚讶焉咽阉烟淹盐严研蜒岩延言颜阎炎沿奄掩眼衍演艳堰燕厌砚雁唁彦焰宴谚验殃央鸯秧杨扬佯疡羊洋阳氧仰痒养样漾邀腰妖瑶摇尧遥窑谣姚咬舀药要耀椰噎耶爷野冶也页掖业叶曳腋夜液一壹医揖铱依伊衣颐夷遗移仪胰疑沂宜姨彝椅蚁倚已乙矣以艺抑易邑屹亿役臆逸肄疫亦裔意毅忆义益溢诣议谊译异翼翌绎茵荫因殷音阴姻吟银淫寅饮尹引隐印英樱婴鹰应缨莹萤营荧蝇迎赢盈影颖硬映哟拥佣臃痈庸雍踊蛹咏泳涌永恿勇用幽优悠忧尤由邮铀犹油游酉有友右佑釉诱又幼迂淤于盂榆虞愚舆余俞逾鱼愉渝渔隅予娱雨与屿禹宇语羽玉域芋郁遇喻峪御愈欲狱育誉浴寓裕预豫驭鸳渊冤元垣袁原援辕园员圆猿源缘远苑愿怨院曰约越跃钥岳粤月悦阅耘云郧匀陨允运蕴酝晕韵孕轧","z":"幢翟咀匝砸杂栽哉灾宰载再在咱攒暂赞赃脏葬遭糟凿藻枣早澡蚤躁噪造皂灶燥责择则泽贼怎增憎赠扎喳渣札铡闸眨榨咋乍炸诈摘斋宅窄债寨瞻毡詹沾盏斩崭展蘸栈占战站湛绽樟章彰漳张掌涨杖丈帐账仗胀瘴障招昭找沼赵照罩兆肇召遮折哲蛰辙者锗蔗这浙珍斟真甄砧臻贞针侦枕疹诊震振镇阵蒸挣睁征狰争怔整拯正政帧症郑证芝枝支吱蜘知肢脂汁之织职直植殖执值侄址指止趾只旨纸志挚掷至致置帜峙制智秩稚质炙痔滞治窒中盅忠钟衷终种肿重仲众舟周州洲诌粥轴肘帚咒皱宙昼骤珠株蛛朱猪诸诛逐竹烛煮拄瞩嘱主著柱助蛀贮铸筑住注祝驻抓爪拽专砖转撰赚篆桩庄装妆撞壮状椎锥追赘坠缀谆准捉拙卓桌琢茁酌啄着灼浊兹咨资姿滋淄孜紫仔籽滓子自渍字鬃棕踪宗综总纵邹走奏揍租足卒族祖诅阻组钻纂嘴醉最罪尊遵昨左佐柞做作坐座"};

  let pyMap = null;
  function getPyMap() {
    if (pyMap) return pyMap;
    pyMap = new Map();
    for (const k in PY_TABLE) {
      if (!Object.prototype.hasOwnProperty.call(PY_TABLE, k)) continue;
      const s = PY_TABLE[k];
      for (let i = 0; i < s.length; i++) pyMap.set(s[i], k);
    }
    return pyMap;
  }
  function pyOf(str) {
    const map = getPyMap();
    let out = '';
    const chars = Array.from(String(str || ''));
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const hit = map.get(ch);
      out += hit ? hit : (/[a-z0-9]/i.test(ch) ? ch.toLowerCase() : '');
    }
    return out;
  }

  const API = 'https://api.live.bilibili.com';

  async function tryPaths(list, label) {
    let lastErr = null;
    for (let i = 0; i < list.length; i++) {
      try {
        const json = await list[i]();
        if (json && json.code === 0) return json;
        lastErr = new Error((json && json.message) ? json.message : ('code=' + (json && json.code)));
        if (json && json.code === -101) throw lastErr;
      } catch (e) {
        if (e && /没登录|未登录|code=-101/.test(e.message || '')) throw e;
        lastErr = e;
      }
    }
    throw lastErr || new Error(label + '全部失败');
  }

  // ==================== 接口层 ====================
  const state = {
    roomId: '',
    uid: 0,
    myMedalId: 0,      // 你在本房间主播这里的牌子 id
    wearingId: 0,      // 当前佩戴的牌子 id，0 = 没佩戴
    recentId: 0,       // 最近获得的牌子 id
    all: [],           // 面板全部数据（已归一化）
    page: 0,
    totalPage: 1,
    hasMore: false,
    loading: false,
    panelOpen: false,
    listError: '',
    myTried: false    // 本房间是否已问过「当前房间牌子」
  };

  // 房间号 -> 主播 uid
  async function resolveUid(roomId) {
    const json = await tryPaths([
      function () { return request({ url: API + '/room/v1/Room/room_init?id=' + roomId }); },
      function () { return request({ url: API + '/room/v1/Room/get_info?room_id=' + roomId }); },
      function () { return request({ url: API + '/xlive/web-room/v1/index/getInfoByUser?room_id=' + roomId + '&from=0&not_mock_enter_effect=1' }); }
    ], '查主播');
    const d = json.data || {};
    return num(d.uid) || num(d.medal && d.medal.up_medal && d.medal.up_medal.uid)
      || num(d.room_info && d.room_info.uid) || 0;
  }

  // 当前佩戴（能查到就跳过重复佩戴）
  async function currentWorn(roomId) {
    try {
      const json = await request({
        url: API + '/xlive/web-room/v1/index/getInfoByUser?room_id=' + roomId + '&from=0&not_mock_enter_effect=1'
      });
      const c = json && json.data && json.data.medal && json.data.medal.curr_weared;
      if (c) return { targetId: num(c.target_id), medalId: num(c.medal_id) };
    } catch (e) { /* 查不到就算了 */ }
    return null;
  }

  // 我在这个主播这里有没有牌子
  async function findMedal(uid, roomId) {
    try {
      const json = await request({ url: API + '/xlive/app-ucenter/v1/fansMedal/fans_medal_info?target_id=' + uid });
      if (json && json.code === 0) {
        const d = json.data || {};
        if (d.has_fans_medal === false) return null;
        const mine = d.my_fans_medal || d.medal || null;
        if (mine) {
          const one = uniqMedals(collectMedals(mine))[0];
          if (one) {
            one.targetId = one.targetId || uid;
            if (!one.name || one.name === '粉丝牌') one.name = d.medal_name || one.name;
            return one;
          }
        }
        const all = collectMedals(d);
        for (let i = 0; i < all.length; i++) {
          if (all[i].targetId === uid || all[i].targetId === 0) return all[i];
        }
        return null;
      }
      if (json && json.code === -101) throw new Error('账号未登录');
    } catch (e) {
      if (/未登录|没登录|code=-101/.test(e.message || '')) throw e;
    }

    const lists = [
      function () { return request({ url: API + '/xlive/app-ucenter/v1/fansMedal/panel?page=1&page_size=100&target_id=' + uid }); },
      function () { return request({ url: API + '/xlive/app-ucenter/v1/user/GetMyMedals?page=1&page_size=10' }); }
    ];
    let lastErr = null;
    for (let i = 0; i < lists.length; i++) {
      try {
        const json = await lists[i]();
        if (!json || json.code !== 0) {
          if (json && json.code === -101) throw new Error('账号未登录');
          lastErr = new Error((json && json.message) || 'code=' + (json && json.code));
          continue;
        }
        const all = uniqMedals(collectMedals(json.data));
        for (let j = 0; j < all.length; j++) {
          if (all[j].targetId === uid || (roomId && all[j].roomId === num(roomId))) return all[j];
        }
        const pi = json.data && json.data.page_info;
        const total = pi ? Math.min(20, num(pi.total_page) || 1) : 1;
        for (let p = 2; p <= total; p++) {
          try {
            const more = await request({ url: API + '/xlive/app-ucenter/v1/user/GetMyMedals?page=' + p + '&page_size=10' });
            const arr = uniqMedals(collectMedals(more.data));
            for (let j = 0; j < arr.length; j++) {
              if (arr[j].targetId === uid || (roomId && arr[j].roomId === num(roomId))) return arr[j];
            }
          } catch (e) { /* 单页失败忽略 */ }
        }
        return null;
      } catch (e) {
        if (/未登录|没登录|code=-101/.test(e.message || '')) throw e;
        lastErr = e;
      }
    }
    throw lastErr || new Error('勋章列表全部读取失败');
  }

  async function wearMedal(medalId) {
    const token = getCookie('bili_jct');
    if (!token) throw new Error('未登录（读不到 bili_jct）');
    const body = 'medal_id=' + encodeURIComponent(medalId)
      + '&csrf=' + encodeURIComponent(token)
      + '&csrf_token=' + encodeURIComponent(token)
      + '&visit_id=';
    const urls = [
      API + '/xlive/web-room/v1/fansMedal/wear',
      API + '/xlive/app-ucenter/v1/fansMedal/wear'
    ];
    let last = '';
    for (let i = 0; i < urls.length; i++) {
      const opt = { url: urls[i], method: 'POST', body: body };
      try {
        const json = await request(opt);
        if (json && json.code === 0) return true;
        last = (json && json.message) || ('code=' + (json && json.code));
        const blocked = [-403, -412, -352, -509, 412].indexOf(Number(json && json.code)) >= 0
          || /风控|拦截|风险|非法|来源/.test(String((json && json.message) || ''));
        if (blocked) {
          try {
            const j2 = await requestOtherChannel(opt);
            if (j2 && j2.code === 0) return true;
            last = (j2 && j2.message) || ('code=' + (j2 && j2.code));
          } catch (e2) { last = e2.message || String(e2); }
        }
      } catch (e) { last = e.message || String(e); }
    }
    throw new Error('佩戴失败：' + last);
  }

  async function takeOffMedal() {
    const token = getCookie('bili_jct');
    if (!token) throw new Error('未登录（读不到 bili_jct）');
    const body = 'visit_id=&csrf=' + encodeURIComponent(token) + '&csrf_token=' + encodeURIComponent(token);
    const urls = [
      API + '/xlive/web-room/v1/fansMedal/take_off',
      API + '/xlive/app-ucenter/v1/fansMedal/take_off'
    ];
    let last = '';
    for (let i = 0; i < urls.length; i++) {
      try {
        const json = await request({ url: urls[i], method: 'POST', body: body });
        if (json && json.code === 0) return true;
        last = (json && json.message) || ('code=' + (json && json.code));
      } catch (e) { last = e.message || String(e); }
    }
    throw new Error('取消佩戴失败：' + last);
  }

  // 面板数据：一页
  async function apiPanel(page) {
    const url = API + '/xlive/app-ucenter/v1/fansMedal/panel?page=' + page + '&page_size=50'
      + (state.uid ? '&target_id=' + state.uid : '');
    const json = await request({ url: url });
    if (!json || json.code !== 0) {
      if (json && json.code === -101) throw new Error('账号未登录');
      throw new Error((json && json.message) || ('code=' + (json && json.code)));
    }
    return json.data || {};
  }

  // 统一字段（B 站各版本结构略有差异）
  function normItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const m = (raw.medal && typeof raw.medal === 'object') ? raw.medal : raw;
    const a = (raw.anchor_info && typeof raw.anchor_info === 'object') ? raw.anchor_info : {};
    const r = (raw.room_info && typeof raw.room_info === 'object') ? raw.room_info : {};
    const id = num(m.medal_id) || num(raw.medal_id);
    if (!id) return null;
    return {
      medalId: id,
      name: String(m.medal_name || raw.medal_name || '粉丝牌'),
      level: num(m.level) || num(raw.level),
      intimacy: num(m.intimacy) || num(raw.intimacy),
      next: num(m.next_intimacy) || num(raw.next_intimacy),
      today: num(m.today_feed) || 0,
      dayLimit: num(m.day_limit) || 0,
      lighted: !(m.is_lighted === 0 || raw.is_lighted === 0),
      wearing: !!(m.wearing_status || raw.wearing_status),
      targetId: num(m.target_id) || num(raw.target_id) || num(a.uid),
      anchorName: String(a.nick_name || raw.uname || raw.target_name || ''),
      avatar: String(a.avatar || raw.face || ''),
      verify: a.verify === undefined ? -1 : Number(a.verify),
      roomId: num(r.room_id) || num(raw.roomid) || num(raw.room_id),
      living: (num(r.living_status) || num(raw.living_status)) === 1,
      colorStart: color(m.medal_color_start !== undefined ? m.medal_color_start : raw.medal_color_start, 0xAAAAAA),
      colorEnd: color(m.medal_color_end !== undefined ? m.medal_color_end : raw.medal_color_end, 0xAAAAAA),
      colorBorder: color(m.medal_color_border !== undefined ? m.medal_color_border : raw.medal_color_border, 0xAAAAAA),
      recent: false
    };
  }

  function mergeItems(arr) {
    const map = new Map();
    for (let i = 0; i < state.all.length; i++) map.set(state.all[i].medalId, state.all[i]);
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i];
      if (it) map.set(it.medalId, Object.assign(map.get(it.medalId) || {}, it));
    }
    state.all = Array.from(map.values());
  }

  // ==================== 自动换牌 ====================
  let lastRoom = '';
  let retryStep = 0;
  let retryTimer = 0;
  let busy = false;
  let pendingReason = '';
  let lastStatus = '还没开始';
  let lastError = '';
  let failToastShown = false;
  let lastRunAt = 0;

  function setStatus(s) { lastStatus = s; }

  function scheduleRetry(reason) {
    setStatus(reason);
    if (retryStep >= 4) {
      // 重试到上限还没成功，必须让用户看见原因，不能默默失败
      if (!failToastShown) {
        failToastShown = true;
        if (cfg.notify) toast('粉丝牌没换成功：' + reason + '。点「牌」或按 Alt+M 看状态', 5000);
      }
      return;
    }
    const waits = [5000, 15000, 30000, 60000];
    const delay = waits[retryStep++];
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () { run('自动重试'); }, delay);
  }

  async function run(reason) {
    if (busy) { pendingReason = reason || '排队中'; return; }
    if (!cfg.enabled) { setStatus('自动换牌已关闭'); return; }
    const roomId = readRoomId();
    if (!roomId) { setStatus('这不是直播间页面'); return; }
    if (retryStep === 0) { failToastShown = false; lastError = ''; }
    if (!getCookie('bili_jct')) { scheduleRetry('没读到登录信息，等会儿再试'); return; }

    busy = true;
    lastRunAt = Date.now();
    try {
      setStatus('正在查这个主播的牌子…');
      const uid = await resolveUid(roomId);
      if (!uid) throw new Error('查不到主播 uid');
      state.uid = uid;
      state.roomId = roomId;

      const medal = await findMedal(uid, roomId);
      if (!medal) {
        state.myMedalId = 0;
        if (cfg.fallbackDefault && num(cfg.defaultMedalId)) {
          await wearMedal(cfg.defaultMedalId);
          state.wearingId = num(cfg.defaultMedalId);
          setStatus('你没有这个主播的牌子，已切回「' + (cfg.defaultMedalName || '默认牌') + '」');
          if (cfg.notify) toast('没有这个主播的牌子，已切回默认牌');
          publishWearing(state.wearingId);
        } else {
          setStatus('你没有这个主播的粉丝牌，保持不变');
        }
        retryStep = 0;
        return;
      }

      state.myMedalId = medal.id;
      const worn = await currentWorn(roomId);
      if (worn && worn.targetId === uid) {
        state.wearingId = worn.medalId || medal.id;
        setStatus('已经是「' + medal.name + '」，不用换');
        publishWearing(state.wearingId);
        retryStep = 0;
        if (state.panelOpen) renderRows();
        return;
      }

      setStatus('正在换牌…');
      await wearMedal(medal.id);
      state.wearingId = medal.id;
      publishWearing(medal.id);
      setStatus('已换成「' + medal.name + '」' + (medal.level ? ' Lv.' + medal.level : ''));
      retryStep = 0;
      clearTimeout(retryTimer);
      if (cfg.notify) toast('粉丝牌已换成「' + medal.name + '」');
      if (state.panelOpen) renderRows();
    } catch (e) {
      lastError = (e && e.message ? e.message : String(e));
      scheduleRetry('没换成：' + lastError);
    } finally {
      busy = false;
      if (pendingReason) {
        const r = pendingReason;
        pendingReason = '';
        setTimeout(function () { run(r); }, 300);
      }
    }
  }

  // 多标签页同步当前佩戴
  const WEAR_KEY = 'blam_wearing_v2';
  function publishWearing(id) {
    try {
      const raw = JSON.stringify({ id: num(id), t: Date.now() });
      if (typeof GM_setValue === 'function') GM_setValue(WEAR_KEY, raw);
      else localStorage.setItem(WEAR_KEY, raw);
    } catch (e) { /* ignore */ }
  }
  if (typeof GM_addValueChangeListener === 'function') {
    try {
      GM_addValueChangeListener(WEAR_KEY, function (name, oldV, newV, remote) {
        if (!remote) return;
        let id = 0;
        try { id = num(JSON.parse(newV || '{}').id); } catch (e) { id = 0; }
        if (id) { state.wearingId = id; if (state.panelOpen) renderRows(); }
      });
    } catch (e) { /* ignore */ }
  } else {
    try {
      window.addEventListener('storage', function (ev) {
        if (ev.key !== WEAR_KEY || !ev.newValue) return;
        let id = 0;
        try { id = num(JSON.parse(ev.newValue).id); } catch (e) { id = 0; }
        if (id) { state.wearingId = id; if (state.panelOpen) renderRows(); }
      });
    } catch (e) { /* ignore */ }
  }

  // 站内跳房间
  setInterval(function () {
    const roomId = readRoomId();
    if (roomId && roomId !== lastRoom) {
      lastRoom = roomId;
      retryStep = 0;
      clearTimeout(retryTimer);
      state.all = [];
      state.page = 0;
      state.uid = 0;
      state.myMedalId = 0;
      state.myTried = false;
      if (state.panelOpen) closePanel();
      mountEntry();
      run('进入直播间');
    }
  }, 2500);

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (/没换成|没读到|查不到|失败|超时/.test(lastStatus) && Date.now() - lastRunAt > 10000) {
      retryStep = 0;
      run('切回页面重试');
    }
  });

  // ==================== 轻提示 ====================
  let toastTimer = 0;
  let pendingToast = '';
  let toastBound = false;
  function toast(msg, ms) {
    ms = ms || 2200;
    if (!document.body) {
      pendingToast = msg;
      if (!toastBound) {
        toastBound = true;
        document.addEventListener('DOMContentLoaded', function () {
          if (!pendingToast) return;
          const m = pendingToast;
          pendingToast = '';
          setTimeout(function () { toast(m, ms); }, 0);
        });
      }
      return;
    }
    try {
      let el = document.getElementById('blam-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'blam-toast';
        document.body.appendChild(el);
      }
      el.className = 'blam-toast' + (isDark() ? ' blam-dark' : '');
      el.textContent = msg;
      el.style.opacity = '1';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { el.style.opacity = '0'; }, ms);
    } catch (e) { /* ignore */ }
  }

  function isDark() {
    try {
      const de = document.documentElement;
      if (de.classList.contains('dark') || de.dataset.theme === 'dark' || de.getAttribute('data-theme') === 'dark') return true;
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return true;
      const bg = getComputedStyle(document.body).backgroundColor || '';
      const m = bg.match(/(\d+),\s*(\d+),\s*(\d+)/);
      if (m) return (Number(m[1]) * 299 + Number(m[2]) * 587 + Number(m[3]) * 114) / 1000 < 128;
    } catch (e) { /* ignore */ }
    return false;
  }

  // ==================== 样式（只注入一次） ====================
  const CSS = [
    '#blam-toast{position:fixed;z-index:2147483000;left:50%;bottom:72px;transform:translateX(-50%);max-width:80vw;',
    'padding:9px 16px;border-radius:8px;font-size:13px;line-height:1.5;pointer-events:none;opacity:0;transition:opacity .2s;',
    'background:rgba(255,255,255,.97);color:#18191c;border:1px solid rgba(0,0,0,.1);box-shadow:0 4px 18px rgba(0,0,0,.18);',
    'font-family:-apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif}',
    '#blam-toast.blam-dark{background:rgba(40,44,52,.96);color:#f1f2f4;border-color:rgba(255,255,255,.14)}',

    // 提示原生按钮位置的高亮框（点「B站原版」后闪一下，告诉用户该点哪儿）
    '.blam-hint{position:fixed;z-index:2147483098;pointer-events:none;border:2px solid #fb7299;border-radius:8px;',
    'box-shadow:0 0 0 4px rgba(251,114,153,.22);animation:blam-hint-pulse .9s ease-in-out infinite}',
    '@keyframes blam-hint-pulse{0%,100%{opacity:.55}50%{opacity:1}}',
    '#blam-panel{position:fixed;z-index:2147483100;width:326px;max-height:min(78vh,560px);display:flex;flex-direction:column;',
    'border-radius:10px;overflow:hidden;font-size:13px;background:#fff;color:#18191c;border:1px solid rgba(0,0,0,.1);',
    'box-shadow:0 10px 40px rgba(0,0,0,.22);font-family:-apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif}',
    '#blam-panel.blam-dark{background:#1f2329;color:#e6e8eb;border-color:rgba(255,255,255,.12)}',
    '.blam-head{display:flex;align-items:center;gap:8px;padding:10px 12px 8px;flex-shrink:0}',
    '.blam-title{font-size:14px;font-weight:600}',
    '.blam-head a{color:#00aeec;text-decoration:none;font-size:12px;opacity:.85}',
    '.blam-close{margin-left:auto;cursor:pointer;width:22px;height:22px;line-height:20px;text-align:center;border-radius:5px;font-size:17px;opacity:.65}',
    '.blam-close:hover{background:rgba(0,0,0,.06);opacity:1}',
    '#blam-panel.blam-dark .blam-close:hover{background:rgba(255,255,255,.1)}',
    '.blam-search-wrap{padding:0 12px 8px;flex-shrink:0}',
    '#blam-search{width:100%;box-sizing:border-box;padding:7px 10px;border-radius:6px;outline:none;font-size:13px;',
    'border:1px solid rgba(0,0,0,.12);background:rgba(0,0,0,.035);color:inherit}',
    '#blam-panel.blam-dark #blam-search{border-color:rgba(255,255,255,.16);background:rgba(255,255,255,.07)}',
    '.blam-list{overflow:auto;flex:1;padding:0 8px 4px;scrollbar-width:thin}',
    '.blam-row{display:flex;gap:8px;padding:7px 6px;border-radius:7px;cursor:pointer;align-items:flex-start}',
    '.blam-row:hover{background:rgba(0,0,0,.045)}',
    '#blam-panel.blam-dark .blam-row:hover{background:rgba(255,255,255,.07)}',
    '.blam-row.is-outdated{opacity:.55}',
    '.blam-avatar{position:relative;width:36px;height:36px;flex-shrink:0;display:block;border-radius:50%}',
    '.blam-avatar>img{width:36px;height:36px;border-radius:50%;object-fit:cover;display:block}',
    '.blam-ring{position:absolute;inset:-2px;border:1px solid #fb7299;border-radius:50%;opacity:0;pointer-events:none}',
    '.blam-avatar.blam-live .blam-ring{animation:blam-ring 1.6s linear infinite}',
    '@keyframes blam-ring{0%{transform:scale(1);opacity:.9}100%{transform:scale(1.28);opacity:0}}',
    '.blam-vfy{position:absolute;right:-1px;bottom:-1px;width:12px;height:12px;border-radius:50%;',
    'background:#ffb027;border:1.5px solid #fff;box-sizing:border-box}',
    '#blam-panel.blam-dark .blam-vfy{border-color:#1f2329}',
    '.blam-main{flex:1;min-width:0}',
    '.blam-line1{display:flex;align-items:center;gap:6px;height:18px}',
    '.blam-medal{display:inline-flex;align-items:stretch;height:17px;border:1px solid #aaa;border-radius:3px;overflow:hidden;flex-shrink:0}',
    '.blam-medal-name{padding:0 4px;font-size:11px;line-height:15px;color:#fff;max-width:96px;overflow:hidden;',
    'text-overflow:ellipsis;white-space:nowrap}',
    '.blam-medal-lv{padding:0 3px;font-size:11px;line-height:15px;font-weight:700;background:#fff;min-width:12px;text-align:center}',
    '#blam-panel.blam-dark .blam-medal-lv{background:#1f2329}',
    '.blam-tag{font-size:10px;line-height:14px;padding:0 3px;border-radius:3px;border:1px solid currentColor;flex-shrink:0}',
    '.blam-tag.wear{color:#fb7299}',
    '.blam-tag.room{color:#fea249}',
    '.blam-tag.recent{color:#40bf55}',
    '.blam-line2{display:flex;align-items:center;gap:6px;margin-top:2px}',
    '.blam-anchor{color:inherit;text-decoration:none;font-size:12px;opacity:.85;max-width:120px;overflow:hidden;',
    'text-overflow:ellipsis;white-space:nowrap}',
    '.blam-anchor:hover{color:#00aeec;opacity:1}',
    '.blam-today{margin-left:auto;font-size:11px;opacity:.6;flex-shrink:0}',
    '.blam-prog{display:flex;align-items:center;gap:4px;margin-top:3px;font-size:10px;opacity:.75}',
    '.blam-bar{position:relative;flex:1;height:10px;border-radius:2px;background:rgba(0,0,0,.09);overflow:hidden}',
    '#blam-panel.blam-dark .blam-bar{background:rgba(255,255,255,.13)}',
    '.blam-bar>i{position:absolute;left:0;top:0;bottom:0;background:#23ade5;display:block}',
    '.blam-bar>span{position:absolute;inset:0;text-align:center;line-height:10px;color:#fff;font-size:9px;',
    'text-shadow:0 0 2px rgba(0,0,0,.5)}',
    '.blam-loading{text-align:center;font-size:12px;opacity:.55;padding:10px 0}',
    '.blam-foot{display:flex;align-items:center;padding:8px 12px;border-top:1px solid rgba(0,0,0,.08);flex-shrink:0;gap:10px}',
    '#blam-panel.blam-dark .blam-foot{border-color:rgba(255,255,255,.1)}',
    '.blam-foot span,.blam-foot a{cursor:pointer;font-size:12px;color:#00aeec;text-decoration:none}',
    '.blam-foot .blam-right{margin-left:auto}',

    // 入口按钮固定在 body 上（position:fixed），不插进 B 站 Vue 渲染的聊天区，
    // 免得页面重渲染时被连根拔掉。
    '.blam-entry{position:fixed;z-index:2147483000;display:flex;align-items:center;justify-content:center;',
    'width:26px;height:26px;border-radius:6px;cursor:pointer;font-size:12px;color:#fff;',
    'background:linear-gradient(135deg,#fb7299,#00aeec);opacity:.72;user-select:none;',
    'box-shadow:0 1px 5px rgba(0,0,0,.25);transition:opacity .15s;line-height:1}',
    '.blam-entry:hover{opacity:1}',

    // 设置窗口：点「展开设置」直接显示在直播页面上，改动先进草稿，点「保存」才落盘
    '#blam-settings-backdrop{position:fixed;inset:0;z-index:2147483150;background:rgba(0,0,0,.38)}',
    '#blam-settings{position:fixed;z-index:2147483160;left:50%;top:50%;transform:translate(-50%,-50%);',
    'width:min(430px,calc(100vw - 32px));max-height:min(84vh,700px);display:flex;flex-direction:column;',
    'border-radius:12px;overflow:hidden;background:#fff;color:#18191c;border:1px solid rgba(0,0,0,.1);',
    'box-shadow:0 18px 60px rgba(0,0,0,.3);font-size:13px;line-height:1.5;',
    'font-family:-apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif}',
    '#blam-settings.blam-dark{background:#1f2329;color:#e6e8eb;border-color:rgba(255,255,255,.12)}',
    '.blam-st-head{display:flex;align-items:center;gap:8px;padding:13px 16px;border-bottom:1px solid rgba(0,0,0,.08);flex-shrink:0}',
    '#blam-settings.blam-dark .blam-st-head{border-color:rgba(255,255,255,.1)}',
    '.blam-st-title{font-size:15px;font-weight:600}',
    '.blam-st-tip{font-size:11px;opacity:.6}',
    '.blam-st-close{margin-left:auto;cursor:pointer;width:24px;height:24px;line-height:22px;text-align:center;',
    'border-radius:6px;font-size:18px;opacity:.6}',
    '.blam-st-close:hover{background:rgba(0,0,0,.06);opacity:1}',
    '#blam-settings.blam-dark .blam-st-close:hover{background:rgba(255,255,255,.1)}',
    '.blam-st-body{overflow:auto;padding:4px 16px 12px;flex:1;scrollbar-width:thin}',
    '.blam-st-sec{font-size:11px;font-weight:600;opacity:.55;letter-spacing:.5px;margin:14px 0 4px}',
    '.blam-st-row{display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-bottom:1px solid rgba(0,0,0,.05)}',
    '#blam-settings.blam-dark .blam-st-row{border-color:rgba(255,255,255,.07)}',
    '.blam-st-row>input[type=checkbox]{width:16px;height:16px;margin:2px 0 0;flex-shrink:0;accent-color:#fb7299;cursor:pointer}',
    '.blam-st-label{font-size:13px;font-weight:500}',
    'label.blam-st-row,.blam-st-label{cursor:pointer}',
    '.blam-st-desc{font-size:11px;opacity:.6;margin-top:2px}',
    '.blam-st-select{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;font-size:13px;',
    'border:1px solid rgba(0,0,0,.14);background:rgba(0,0,0,.035);color:inherit;outline:none}',
    '#blam-settings.blam-dark .blam-st-select{border-color:rgba(255,255,255,.16);background:rgba(255,255,255,.07)}',
    '.blam-st-inline{display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap}',
    '.blam-st-hint{font-size:11px;opacity:.6;margin-top:6px}',
    '.blam-st-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}',
    '.blam-st-btn{padding:5px 11px;border-radius:6px;font-size:12px;cursor:pointer;border:1px solid rgba(0,0,0,.14);',
    'background:rgba(0,0,0,.035);color:inherit}',
    '#blam-settings.blam-dark .blam-st-btn{border-color:rgba(255,255,255,.16);background:rgba(255,255,255,.07)}',
    '.blam-st-btn:hover{opacity:.78}',
    '.blam-st-foot{display:flex;align-items:center;gap:8px;padding:11px 16px;border-top:1px solid rgba(0,0,0,.08);flex-shrink:0}',
    '#blam-settings.blam-dark .blam-st-foot{border-color:rgba(255,255,255,.1)}',
    '.blam-st-foot-tip{font-size:11px;opacity:.6}',
    '.blam-st-cancel{padding:7px 14px;border-radius:7px;font-size:13px;cursor:pointer;border:1px solid rgba(0,0,0,.14);',
    'background:transparent;color:inherit}',
    '#blam-settings.blam-dark .blam-st-cancel{border-color:rgba(255,255,255,.18)}',
    '.blam-st-save{margin-left:auto;padding:7px 20px;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;',
    'border:0;color:#fff;background:#fb7299}',
    '.blam-st-save:hover{background:#f25d8e}'
  ].join('');

  let cssInjected = false;
  function injectCSS() {
    if (cssInjected) return;
    try {
      if (document.getElementById('blam-style')) { cssInjected = true; return; }
      const s = document.createElement('style');
      s.id = 'blam-style';
      s.textContent = CSS;
      (document.head || document.documentElement).appendChild(s);
      cssInjected = true;
    } catch (e) { /* ignore */ }
  }

  // ==================== 粉丝牌面板 ====================
  let panelEl = null, listEl = null, searchEl = null, loadingEl = null;
  let panelRO = null;   // 面板内容变高/变矮时重新贴住按钮

  function closePanel() {
    if (panelRO) { try { panelRO.disconnect(); } catch (e) { /* ignore */ } panelRO = null; }
    if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    panelEl = listEl = searchEl = loadingEl = null;
    state.panelOpen = false;
  }

  // 返回 true 表示这次确实由脚本接管了（面板真开了 / 真关了）。
  // 返回 false 时调用方必须把事件放行给 B 站，绝不能把原生按钮变成死键。
  function togglePanel() {
    // 主动打开/收起脚本面板 = 用户已经不用 B 站原版了，立刻结束放行窗口
    if (bypassNative) endBypass();
    if (state.panelOpen) { closePanel(); return true; }
    try {
      // openPanel 是 async：函数体在第一个 await 之前是同步跑的，
      // 所以正常情况下面板此刻已经挂进 body，可以直接判断 panelOpen。
      // 但它抛错时会变成 rejected promise（不是同步 throw），必须单独 catch，
      // 否则既接不住失败、又会留下未处理的 Promise 拒绝。
      const p = openPanel();
      if (p && typeof p.catch === 'function') {
        p.catch(function (e) {
          lastError = '打开面板失败：' + (e && e.message ? e.message : String(e));
        });
      }
      return state.panelOpen === true;
    } catch (e) {
      lastError = '打开面板失败：' + (e && e.message ? e.message : String(e));
      return false;
    }
  }

  async function openPanel() {
    if (state.panelOpen) return;
    injectCSS();
    if (!document.body) return;

    panelEl = document.createElement('div');
    panelEl.id = 'blam-panel';
    if (isDark()) panelEl.className = 'blam-dark';

    const head = document.createElement('div');
    head.className = 'blam-head';
    const title = document.createElement('div');
    title.className = 'blam-title';
    title.textContent = '粉丝牌';
    const help = document.createElement('a');
    help.href = 'https://link.bilibili.com/p/help/index#/audience-fans-medal';
    help.target = '_blank';
    help.rel = 'noreferrer';
    help.textContent = '说明';
    const closeBtn = document.createElement('div');
    closeBtn.className = 'blam-close';
    closeBtn.textContent = '×';
    closeBtn.onclick = closePanel;
    head.appendChild(title); head.appendChild(help); head.appendChild(closeBtn);

    const searchWrap = document.createElement('div');
    searchWrap.className = 'blam-search-wrap';
    searchEl = document.createElement('input');
    searchEl.id = 'blam-search';
    searchEl.placeholder = '搜索牌子 / 主播 / 房间号 / UID';
    searchEl.value = '';
    searchEl.oninput = function () { renderRows(); };
    searchWrap.appendChild(searchEl);

    listEl = document.createElement('div');
    listEl.className = 'blam-list';
    listEl.onscroll = function () {
      if (!state.hasMore || state.loading) return;
      if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 40) loadPage(state.page + 1);
    };

    const foot = document.createElement('div');
    foot.className = 'blam-foot';
    const off = document.createElement('span');
    off.textContent = '不佩戴勋章';
    off.onclick = async function () {
      try {
        await takeOffMedal();
        state.wearingId = 0;
        publishWearing(0);
        setStatus('已取消佩戴');
        toast('已取消佩戴粉丝牌');
        renderRows();
      } catch (e) { toast(e.message || '取消佩戴失败'); }
    };
    const center = document.createElement('a');
    center.href = 'https://link.bilibili.com/p/center/index#/user-center/wearing-center/my-medal';
    center.target = '_blank';
    center.rel = 'noreferrer';
    center.className = 'blam-right';
    center.textContent = '装扮中心 >';
    const nativeBtn = document.createElement('span');
    nativeBtn.textContent = 'B站原版';
    nativeBtn.title = '关掉本面板并放开拦截：接着点一下高亮的原生粉丝牌图标，弹出的是 B 站原版弹窗（和没装脚本时完全一样）';
    nativeBtn.onclick = openNativePanel;
    const setBtn = document.createElement('span');
    setBtn.textContent = '设置';
    setBtn.title = '在页面上打开设置窗口，改完点「保存」才生效';
    setBtn.onclick = openSettings;
    foot.appendChild(off); foot.appendChild(nativeBtn); foot.appendChild(setBtn); foot.appendChild(center);

    panelEl.appendChild(head);
    panelEl.appendChild(searchWrap);
    panelEl.appendChild(listEl);
    panelEl.appendChild(foot);

    try {
      document.body.appendChild(panelEl);
    } catch (e) {
      panelEl = null;
      throw e;
    }
    positionPanel();
    state.panelOpen = true;

    // 列表是异步加载的，面板高度会变（先 1 行「读取中」，再几十条）。
    // 内容一变化就重新贴一次，保证任何时候都紧贴按钮上方。
    if (typeof ResizeObserver === 'function') {
      try {
        panelRO = new ResizeObserver(function () { if (state.panelOpen) positionPanel(); });
        panelRO.observe(panelEl);
      } catch (e) { panelRO = null; }
    }

    // 首次打开：先列已缓存的，同时拉第一页
    if (state.all.length) renderRows();
    else {
      listEl.innerHTML = '';
      loadingEl = document.createElement('div');
      loadingEl.className = 'blam-loading';
      loadingEl.textContent = '读取中…';
      listEl.appendChild(loadingEl);
    }

    try {
      state.roomId = state.roomId || readRoomId();
      if (!state.uid) state.uid = await resolveUid(state.roomId);
      await loadPage(1, true);
    } catch (e) {
      if (listEl) {
        listEl.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'blam-loading';
        err.textContent = /未登录/.test(e.message || '') ? '请先登录 B 站' : ('读取失败：' + (e.message || e));
        listEl.appendChild(err);
      }
    }
  }

  // ==================== 面板定位：永远贴屏幕右侧 ====================
  // 以前是「贴着原生灯牌按钮的正上方」，问题是按钮在聊天输入框左端，面板右边缘又跟着按钮走，
  // 于是面板整个横在播放器/输入框中间 —— 挡画面、挡弹幕、还挡输入框。
  // 现在的规则：
  //   · 水平：右边缘固定贴窗口右边 8px（只有侧栏本身没贴到窗口右边时才跟随侧栏），
  //           宽度自适应侧栏宽度，永远只在右边那一列里，不会跨到播放器上；
  //   · 垂直：底边停在聊天输入框上沿，向上生长（内容多就长到上限，内部滚动），
  //           所以既不压播放器，也不压输入框。
  const PANEL_W = 326;

  function rectOf(el) {
    if (!el || !el.isConnected) return null;
    let r = null;
    try { r = el.getBoundingClientRect(); } catch (e) { return null; }
    if (!r || r.width < 2 || r.height < 2) return null;
    if (r.top < -4000 || r.left < -4000) return null;   // 明显没渲染/被移出可视区
    return r;
  }

  // 右侧栏外框候选：从最外层容器到最内层，取第一个「像侧栏」的
  const ASIDE_SEL = [
    '#aside-area', '#aside-area-vm', '.aside-area',
    '#chat-history-list', '.chat-history-list', '.chat-history-panel',
    '.chat-input-ctnr', '.chat-input-ctnr-new',
    '#chat-control-panel-vm', '.chat-control-panel'
  ];

  function asideRect() {
    const vw = window.innerWidth || 1280;
    for (let i = 0; i < ASIDE_SEL.length; i++) {
      let el = null;
      try { el = document.querySelector(ASIDE_SEL[i]); } catch (e) { el = null; }
      const r = rectOf(el);
      if (!r) continue;
      if (r.width < 200) continue;                 // 太窄，不是右侧栏
      if (r.right < vw * 0.55) continue;           // 不在屏幕右半边，不是右侧栏
      return r;
    }
    return null;
  }

  // 聊天输入框（面板的垂直锚点：底边停在它上面）
  const INPUT_SEL = [
    '.chat-input-ctnr', '.chat-input-ctnr-new',
    '.chat-input-panel', '#chat-control-panel-vm', '.chat-control-panel'
  ];
  function inputRect() {
    for (let i = 0; i < INPUT_SEL.length; i++) {
      let el = null;
      try { el = document.querySelector(INPUT_SEL[i]); } catch (e) { el = null; }
      const r = rectOf(el);
      if (r && r.height >= 24) return r;
    }
    return null;
  }

  // 诊断用：说明这次面板到底锚在哪儿
  function anchorRect() {
    const aside = asideRect();
    if (aside) return aside;
    const input = inputRect();
    if (input) return input;
    return rectOf(findNativeEl(true));
  }

  function positionPanel() {
    if (!panelEl) return;
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const margin = 8;
    const aside = asideRect();
    const input = inputRect();

    // —— 水平：右边缘贴窗口右边 8px，宽度收进侧栏宽度里 ——
    // 侧栏本身没贴到窗口右边（窄屏居中 / 有边距）时跟着侧栏走，免得面板悬在空白处。
    let w = PANEL_W;
    let right = margin;
    if (aside) {
      w = Math.max(240, Math.min(PANEL_W, Math.round(aside.width) - 16));
      const gapRight = Math.round(vw - aside.right);
      if (gapRight > 24) right = gapRight + margin;
    }

    // —— 垂直：底边停在输入框上沿 ——
    let baseTop = 0;
    if (input) baseTop = input.top;
    else if (aside) baseTop = aside.bottom;
    let bottom = baseTop ? Math.max(margin, Math.round(vh - baseTop) + margin) : margin;

    let maxH = Math.min(560, Math.round(vh * 0.78), Math.round(vh - bottom - 64));
    if (maxH < 240) {
      // 输入框上方空间不够（窗口很矮 / 布局特殊）→ 干脆整列铺满，仍然只在右侧
      bottom = margin;
      maxH = Math.max(220, Math.min(560, Math.round(vh - margin * 2 - 56)));
    }

    panelEl.style.width = w + 'px';
    panelEl.style.left = 'auto';
    panelEl.style.right = right + 'px';
    panelEl.style.top = 'auto';
    panelEl.style.bottom = bottom + 'px';
    panelEl.style.maxHeight = maxH + 'px';
  }

  async function loadPage(page, reset) {
    if (state.loading) return;
    state.loading = true;
    if (reset) { state.page = 0; state.totalPage = 1; state.hasMore = false; }
    try {
      const data = await apiPanel(page);
      const rawList = Array.isArray(data.list) ? data.list : [];
      const rawSpecial = Array.isArray(data.special_list) ? data.special_list : [];
      const items = [];
      for (let i = 0; i < rawList.length; i++) { const it = normItem(rawList[i]); if (it) items.push(it); }
      for (let i = 0; i < rawSpecial.length; i++) {
        const raw = rawSpecial[i];
        const it = normItem(raw);
        if (!it) continue;
        items.push(it);
        if (page === 1) {
          if (it.wearing || raw.superscript === null || raw.superscript === undefined) {
            if (!state.wearingId) state.wearingId = it.medalId;
          }
          const sup = raw.superscript;
          if (sup && Number(sup.type) === 2) { state.recentId = it.medalId; it.recent = true; }
        }
      }
      mergeItems(items);
      if (page === 1 && !state.wearingId) {
        for (let i = 0; i < state.all.length; i++) {
          if (state.all[i].wearing) { state.wearingId = state.all[i].medalId; break; }
        }
      }
      const pi = data.page_info || {};
      const cur = num(pi.current_page) || num(pi.cur_page) || num(pi.page) || page;
      const total = num(pi.total_page) || cur;
      state.page = cur;
      state.totalPage = total;
      const hasMoreFlag = (pi.has_more !== undefined) ? !!pi.has_more : cur < total;
      state.hasMore = hasMoreFlag && cur < total;
      state.listError = '';

      // 补一次「当前房间牌子」，用于打标签（每房间只问一次）
      if (!state.myMedalId && !state.myTried && state.uid) {
        state.myTried = true;
        try {
          const info = await request({ url: API + '/xlive/app-ucenter/v1/fansMedal/fans_medal_info?target_id=' + state.uid });
          if (info && info.code === 0 && info.data && info.data.has_fans_medal !== false) {
            const mine = info.data.my_fans_medal;
            if (mine) state.myMedalId = num(mine.medal_id);
          }
        } catch (e) { /* 忽略 */ }
      }
      renderRows();
    } catch (e) {
      state.listError = e.message || String(e);
      if (listEl) {
        listEl.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'blam-loading';
        err.textContent = /未登录/.test(state.listError) ? '请先登录 B 站' : ('读取失败：' + state.listError);
        listEl.appendChild(err);
      }
    } finally {
      state.loading = false;
      // 加载结束后刷新尾部文案（renderRows 执行时还在 loading 中，会显示「正在加载…」）
      if (loadingEl) loadingEl.textContent = state.hasMore ? '往下滑加载更多' : '没有了';
    }
  }

  // 佩戴判定：接口自己标的 wearing_status 也算，避免本地状态和接口不一致时标签丢失
  function isWearing(it) { return !!it && (it.medalId === state.wearingId || !!it.wearing); }

  function rankOf(it) {
    if (it.medalId === state.myMedalId) return 0;   // 当前房间
    if (isWearing(it)) return 1;                    // 佩戴中
    if (it.medalId === state.recentId) return 2;    // 最近获得
    return 3;
  }

  function sortRows(a, b) {
    const ra = rankOf(a), rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    if (a.lighted !== b.lighted) return a.lighted ? -1 : 1;
    if (a.level !== b.level) return b.level - a.level;
    return b.intimacy - a.intimacy;
  }

  function matchKw(it, terms) {
    if (!terms.length) return true;
    const hay = (it.name + ' ' + it.anchorName + ' ' + (it.roomId || '') + ' ' + (it.targetId || '')).toLowerCase();
    if (!it._py) it._py = pyOf(it.name + ' ' + it.anchorName);
    for (let i = 0; i < terms.length; i++) {
      // 中文/数字直接匹配；字母还能按拼音首字母匹配（如 blp -> 别/的/牌）
      if (hay.indexOf(terms[i]) < 0 && it._py.indexOf(terms[i]) < 0) return false;
    }
    return true;
  }

  function renderRows() {
    if (!listEl || !state.panelOpen) return;
    const kw = (searchEl && searchEl.value ? searchEl.value : '').toLowerCase().trim();
    const terms = kw ? kw.split(/\s+/).filter(Boolean) : [];
    const rows = state.all.filter(function (it) { return matchKw(it, terms); }).sort(sortRows);

    listEl.innerHTML = '';
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'blam-loading';
      empty.textContent = kw ? '没找到匹配的粉丝牌' : '还没有读到粉丝牌';
      listEl.appendChild(empty);
    } else {
      for (let i = 0; i < rows.length; i++) listEl.appendChild(buildRow(rows[i]));
    }

    loadingEl = document.createElement('div');
    loadingEl.className = 'blam-loading';
    loadingEl.textContent = state.loading ? '正在加载…' : (state.hasMore ? '往下滑加载更多' : '没有了');
    listEl.appendChild(loadingEl);

    // 搜索时本地没有结果但还有下一页，自动再拉一页
    if (kw && !rows.length && state.hasMore && !state.loading) loadPage(state.page + 1);
  }

  function buildRow(it) {
    const row = document.createElement('div');
    row.className = 'blam-row' + (it.lighted ? '' : ' is-outdated');
    row.title = (isWearing(it) ? '点击取消佩戴' : '点击佩戴') + '「' + it.name + '」';

    // 头像（直播中带光圈，点击进直播间）
    const avatar = document.createElement('a');
    avatar.className = 'blam-avatar' + (it.living ? ' blam-live' : '');
    avatar.href = it.roomId ? ('https://live.bilibili.com/' + it.roomId) : 'https://live.bilibili.com/';
    avatar.target = '_blank';
    avatar.rel = 'noreferrer';
    avatar.onclick = function (e) { e.stopPropagation(); };
    if (it.avatar) {
      const img = document.createElement('img');
      img.src = it.avatar;
      img.loading = 'lazy';
      img.onerror = function () { img.style.display = 'none'; };
      avatar.appendChild(img);
    }
    if (it.verify === 0) {
      const v = document.createElement('i');
      v.className = 'blam-vfy';
      avatar.appendChild(v);
    }
    if (it.living) {
      const ring = document.createElement('i');
      ring.className = 'blam-ring';
      avatar.appendChild(ring);
    }

    const main = document.createElement('div');
    main.className = 'blam-main';

    // 第一行：勋章牌 + 状态标签
    const line1 = document.createElement('div');
    line1.className = 'blam-line1';
    const badge = document.createElement('span');
    badge.className = 'blam-medal';
    badge.style.borderColor = '#' + hex(it.colorBorder);
    const bn = document.createElement('span');
    bn.className = 'blam-medal-name';
    bn.textContent = it.name;
    bn.style.backgroundImage = 'linear-gradient(45deg,#' + hex(it.colorStart) + ',#' + hex(it.colorEnd) + ')';
    const bl = document.createElement('span');
    bl.className = 'blam-medal-lv';
    bl.textContent = String(it.level);
    bl.style.color = '#' + hex(it.colorStart);
    badge.appendChild(bn); badge.appendChild(bl);
    line1.appendChild(badge);

    if (isWearing(it)) {
      const t = document.createElement('span'); t.className = 'blam-tag wear'; t.textContent = '佩戴中';
      line1.appendChild(t);
    } else if (it.medalId === state.myMedalId) {
      const t = document.createElement('span'); t.className = 'blam-tag room'; t.textContent = '当前房间';
      line1.appendChild(t);
    } else if (it.medalId === state.recentId) {
      const t = document.createElement('span'); t.className = 'blam-tag recent'; t.textContent = '最近获得';
      line1.appendChild(t);
    }

    // 第二行：主播名 + 今日亲密度
    const line2 = document.createElement('div');
    line2.className = 'blam-line2';
    const anchor = document.createElement('a');
    anchor.className = 'blam-anchor';
    anchor.href = it.targetId ? ('https://space.bilibili.com/' + it.targetId) : 'https://space.bilibili.com/';
    anchor.target = '_blank';
    anchor.rel = 'noreferrer';
    anchor.textContent = it.anchorName || '未知主播';
    anchor.onclick = function (e) { e.stopPropagation(); };
    line2.appendChild(anchor);
    if (it.dayLimit) {
      const today = document.createElement('span');
      today.className = 'blam-today';
      today.textContent = '今日 ' + fmt(it.today) + '/' + fmt(it.dayLimit);
      line2.appendChild(today);
    }

    // 第三行：等级进度
    const prog = document.createElement('div');
    prog.className = 'blam-prog';
    const lvA = document.createElement('span'); lvA.textContent = 'Lv.' + it.level;
    const bar = document.createElement('div'); bar.className = 'blam-bar';
    const next = it.next || 0;
    const pct = next > 0 ? Math.max(0, Math.min(100, it.intimacy / next * 100)) : 0;
    const fill = document.createElement('i'); fill.style.width = pct.toFixed(1) + '%';
    const txt = document.createElement('span');
    txt.textContent = next > 0 ? (fmt(it.intimacy) + '/' + fmt(next)) : '—';
    bar.appendChild(fill); bar.appendChild(txt);
    const lvB = document.createElement('span'); lvB.textContent = 'Lv.' + (it.level + 1);
    prog.appendChild(lvA); prog.appendChild(bar); prog.appendChild(lvB);

    main.appendChild(line1);
    main.appendChild(line2);
    main.appendChild(prog);
    row.appendChild(avatar);
    row.appendChild(main);

    row.onclick = async function () {
      if (row.dataset.busy) return;
      row.dataset.busy = '1';
      row.style.opacity = '.55';
      try {
        if (isWearing(it)) {
          await takeOffMedal();
          state.wearingId = 0;
          publishWearing(0);
          setStatus('已取消佩戴');
          toast('已取消佩戴「' + it.name + '」');
        } else {
          await wearMedal(it.medalId);
          state.wearingId = it.medalId;
          publishWearing(it.medalId);
          setStatus('已换成「' + it.name + '」');
          toast('已佩戴「' + it.name + '」', 2600);
        }
        renderRows();
      } catch (e) {
        row.style.opacity = '';
        toast(e.message || '操作失败');
      } finally {
        delete row.dataset.busy;
      }
    };

    return row;
  }

  // 窗口尺寸变化时重算位置
  window.addEventListener('resize', function () { if (state.panelOpen) positionPanel(); });

  // 点面板外面自动收起：不铺全屏遮罩、也不阻止这次点击，
  // 所以点直播画面暂停、点弹幕都不会被吞掉（老版本那层透明 mask 会吃掉一次点击）
  document.addEventListener('mousedown', function (e) {
    if (!state.panelOpen) return;
    if (panelEl && panelEl.contains(e.target)) return;
    if (inNativeArea(e.target)) return;   // 原生图标交给 click 逻辑处理（那里是"再点收起"）
    closePanel();
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && settingsEl) { closeSettings(true); return; }
    if (e.key === 'Escape' && state.panelOpen) closePanel();
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault();
      if (settingsEl) closeSettings(false);   // 别让粉丝牌面板被设置窗口盖住
      togglePanel();
    }
  });

  // ==================== 原生粉丝牌图标接管 ====================
  // 目标：点 B 站聊天框旁那个原生粉丝牌图标 → 打开本脚本的面板，而不是 B 站原版弹窗。
  //
  // 关键：**不插节点、不替换原生节点、不藏原生按钮**，只在 document 捕获阶段拦 click。
  //   · 没改 DOM → Vue 重渲染抹不掉，也不可能像旧脚本那样「按钮消失后永远回不来」；
  //   · 捕获阶段 stopPropagation → 事件到不了节点，B 站原版弹窗不会跟着一起弹；
  //   · 选择器多候选 + 每次点击实时查 → B 站改类名最多是「没接管」，不会把面板搞死。
  // 需要 B 站原版弹窗时，面板底部有「B站原版」，内部放行一次点击。
  // 需要 B 站原版弹窗时，面板底部有「B站原版」：它只做一件事 —— 临时关掉拦截，
  // 然后请用户再点一次原生图标。那一次是真实点击，B 站收到的事件和没装脚本时一模一样，
  // 所以原版功能不可能"不对"（之前用合成事件模拟点击，Vue 组件内部状态对不上，就是坏在这）。
  //
  // 只列「按钮」，不列 #medal-selector 这类弹层容器：容器本身不是可点目标，
  // 误当按钮会让接管区域变成一大片，点哪儿都被拦。
  const NATIVE_TARGETS = [
    '.chat-input-ctnr .medal-section .action-item.medal',
    '.chat-input-ctnr-new .medal-section .action-item.medal',
    '.medal-section .action-item.medal',
    '.chat-input-ctnr .medal-section',
    '.chat-input-ctnr-new .medal-section',
    '.medal-section',
    '#medal-selector .action-item.medal',
    '#medal-selector .medal'
  ];
  const NATIVE_SEL = NATIVE_TARGETS.join(',');

  // B 站原版弹层（有的版本点图标会先弹它）；用来在开我们自己面板后确认有没有残留
  const NATIVE_POPUP_SEL = [
    '#medal-selector', '.medal-selector', '.medal-panel',
    '.medal-popup', '.medal-list-panel', '.medal-selector-panel'
  ].join(',');

  // 「B站原版」放行窗口：
  //   · 点完按钮后先给 15 秒找到并点到图标（以前只有 2.6 秒，经常来不及）；
  //   · 一旦真的点进去了，再续 60 秒，让用户在 B 站原版弹窗里从容选牌子、不被我们拦；
  //   · 期间脚本一律不拦 click，原版功能与没装脚本完全一致；超时自动恢复接管。
  const BYPASS_FIRST_MS = 15000;
  const BYPASS_ACTIVE_MS = 60000;

  let bypassNative = false;   // 为 true 时放行原生点击（「B站原版」入口用）
  let bypassTimer = 0, bypassUntil = 0;
  let hintEl = null, hintTimer = 0, hintTarget = null;

  function nativeWanted() { return cfg.entryMode !== 'float'; }

  function armBypass(ms) {
    clearTimeout(bypassTimer);
    bypassUntil = Date.now() + ms;
    bypassTimer = setTimeout(endBypass, ms);
  }
  function endBypass() {
    clearTimeout(bypassTimer);
    bypassTimer = 0;
    bypassUntil = 0;
    bypassNative = false;
    clearHint();
  }

  // 按优先级找当前页面上的原生牌子按钮（越靠前越精确）
  // needVisible=true 时只认真的渲染出来、能点到的（用于定位和放行原生点击）
  function findNativeEl(needVisible) {
    for (let i = 0; i < NATIVE_TARGETS.length; i++) {
      let el = null;
      try { el = document.querySelector(NATIVE_TARGETS[i]); } catch (e) { el = null; }
      if (!el || !el.isConnected) continue;
      if (needVisible && !rectOf(el)) continue;
      return el;
    }
    return null;
  }

  // 从点击目标往上找，判断是不是点在原生牌子区域里
  function inNativeArea(node) {
    let el = node;
    let depth = 0;
    while (el && el.nodeType === 1 && el !== document.body && depth++ < 12) {
      try { if (el.matches && el.matches(NATIVE_SEL)) return el; } catch (e) { /* ignore */ }
      el = el.parentElement;
    }
    return null;
  }

  // 只拦 click，**不碰 mousedown**。
  // 之前连 mousedown 一起 stopPropagation，捕获阶段就把事件掐在 document 上，
  // 原生按钮内部的组件根本收不到按下动作 —— B 站自己的 hover / 焦点 / 展开状态全乱，
  // 这就是"原版功能不对"的主因。click 已经足够挡住原版弹窗了。
  function onNativeClickCapture(e) {
    if (!nativeWanted()) return;
    if (bypassNative) {
      // 放行窗口内：点到原生图标 = 用户已经进原版了，续一段更长的时间让他把弹窗用完；
      // 点别的地方不动计时，也不会误把窗口耗掉。
      if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey
        && inNativeArea(e.target)) {
        armBypass(BYPASS_ACTIVE_MS);
        clearHint();   // 已经点到了，高亮框别再一直闪
      }
      return;
    }
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;  // 组合键交还给原版
    if (!inNativeArea(e.target)) return;
    // 先看能不能接住：接不住就什么都不做，事件继续走，原生按钮照常工作
    if (!togglePanel()) return;
    e.preventDefault();
    e.stopPropagation();   // 接住了才拦，B 站自己的弹窗不会跟着弹
    dismissNativePopup();  // 万一 B 站在 mousedown 阶段已经把弹层弹出来了，补一刀关掉
  }

  // 原版弹层若已经可见，就往空处派发一次 mousedown/click，触发 B 站的「点外面关闭」
  function dismissNativePopup() {
    setTimeout(function () {
      let p = null;
      try { p = document.querySelector(NATIVE_POPUP_SEL); } catch (e) { p = null; }
      if (!rectOf(p)) return;
      const blank = document.body;
      const fire = function (type, Ctor) {
        try {
          blank.dispatchEvent(new (Ctor || MouseEvent)(type, {
            bubbles: true, cancelable: true, view: window, button: 0, buttons: 0
          }));
        } catch (e) { /* ignore */ }
      };
      const hasPtr = typeof PointerEvent === 'function';
      fire(hasPtr ? 'pointerdown' : 'mousedown', hasPtr ? PointerEvent : MouseEvent);
      fire('click', MouseEvent);
    }, 260);
  }

  // 在原生按钮外面套一个高亮框，告诉用户"点这里"。
  // 一直显示到真正点到（或放行超时）为止，不像以前 2.4 秒就消失 —— 找图标慢一点也能看见。
  function hintNative(el) {
    clearHint();
    hintTarget = el;
    const draw = function () {
      const r = rectOf(hintTarget);
      if (!r || !document.body) return;   // 元素暂时被 Vue 重渲染掉了：保留上一帧位置
      try {
        if (!hintEl) {
          hintEl = document.createElement('div');
          hintEl.className = 'blam-hint';
          document.body.appendChild(hintEl);
        }
        hintEl.style.left = Math.round(r.left - 4) + 'px';
        hintEl.style.top = Math.round(r.top - 4) + 'px';
        hintEl.style.width = Math.round(r.width + 8) + 'px';
        hintEl.style.height = Math.round(r.height + 8) + 'px';
      } catch (e) { /* ignore */ }
    };
    draw();
    hintTimer = setInterval(draw, 800);   // 跟着图标位置走，不会被页面重渲染甩开
  }

  function clearHint() {
    clearInterval(hintTimer);
    hintTimer = 0;
    if (hintEl && hintEl.parentNode) hintEl.parentNode.removeChild(hintEl);
    hintEl = null;
    hintTarget = null;
  }

  // 「B站原版」：不放合成事件，只放开拦截，让用户自己点一次 —— 最可靠
  function openNativePanel() {
    const el = findNativeEl(true);
    if (!el) { toast('没找到 B 站原生粉丝牌按钮，可能页面还没加载好'); return; }
    closePanel();
    bypassNative = true;
    armBypass(BYPASS_FIRST_MS);
    hintNative(el);
    toast('已切回 B 站原版：点一下粉框里的粉丝牌图标，15 秒内随时点都行（点开后自动续时）', 4600);
  }

  // document-start 就挂上，页面还没渲染完也来得及
  document.addEventListener('click', onNativeClickCapture, true);

  // ==================== 悬浮小入口（备用） ====================
  // 只在「明确要求悬浮按钮」或「原生图标找不到」时出现。
  // 一律挂在 body 上 + position:fixed：插进 B 站 Vue 的 DOM 里会被重渲染抹掉。
  const ANCHORS = [
    '.chat-input-ctnr .medal-section',
    '.chat-input-ctnr-new .medal-section',
    '.medal-section',
    '#medal-selector',
    '.chat-input-ctnr',
    '.chat-input-ctnr-new',
    '.chat-control-panel',
    '#chat-control-panel-vm'
  ];

  function findAnchorRect() {
    for (let i = 0; i < ANCHORS.length; i++) {
      let el = null;
      try { el = document.querySelector(ANCHORS[i]); } catch (e) { el = null; }
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;   // 还没渲染出来 / 被隐藏
      return r;
    }
    return null;
  }

  function positionEntry(btn) {
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const r = findAnchorRect();
    let left, top;
    if (r) {
      left = Math.round(r.left - 30);
      if (left < 4) left = Math.round(r.right + 4);
      top = Math.round(r.top + (r.height - 26) / 2);
    } else {
      // 找不到聊天框就钉在右下角，保证任何时候都能点到
      left = vw - 44;
      top = vh - 160;
    }
    if (left < 4) left = 4;
    if (left > vw - 30) left = vw - 30;
    if (top < 4) top = 4;
    if (top > vh - 30) top = vh - 30;
    btn.style.left = left + 'px';
    btn.style.top = top + 'px';
  }

  // 每 1.5 秒体检一次：按钮丢了就补回来，位置变了就跟上（B 站切房间/换主题会重渲染聊天区）
  function mountEntry() {
    if (!document.body) return;
    // 原生图标能用时就不显示悬浮按钮；B 站改版把图标改没了则自动退回悬浮按钮，保证永远进得去
    const wantFloat = cfg.entryMode === 'float' || cfg.entryMode === 'both'
      || (cfg.entryMode === 'native' && !findNativeEl());
    let btn = document.getElementById('blam-entry');
    if (!wantFloat) {
      if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
      return;
    }
    if (!btn) {
      injectCSS();
      btn = document.createElement('div');
      btn.id = 'blam-entry';
      btn.className = 'blam-entry';
      btn.textContent = '牌';
      btn.title = '粉丝牌面板（Alt+M）';
      btn.onclick = function (e) { e.stopPropagation(); e.preventDefault(); togglePanel(); };
      document.body.appendChild(btn);
    }
    positionEntry(btn);
  }

  let entryTimer = 0;

  function startEntryTimer() {
    clearInterval(entryTimer);
    entryTimer = setInterval(mountEntry, 1500);
    mountEntry();
  }

  startEntryTimer();
  document.addEventListener('DOMContentLoaded', function () { setTimeout(mountEntry, 200); });
  window.addEventListener('load', function () { setTimeout(mountEntry, 200); });

  // ==================== 诊断 ====================
  // 万一还是没反应，用户点一下菜单就能拿到完整现场，不用靠猜。
  function diagText() {
    const anchorsHit = [];
    for (let i = 0; i < ANCHORS.length; i++) {
      try { if (document.querySelector(ANCHORS[i])) anchorsHit.push(ANCHORS[i]); } catch (e) { /* ignore */ }
    }
    return [
      '时间: ' + new Date().toLocaleString(),
      '页面: ' + location.href,
      '房间号: ' + (readRoomId() || '未识别'),
      '脚本版本: 2.4.0',
      '登录 bili_jct: ' + (getCookie('bili_jct') ? '有' : '没有'),
      '登录 DedeUserID: ' + (getCookie('DedeUserID') || '没有'),
      '请求通道: GM_xmlhttpRequest=' + (typeof GM_xmlhttpRequest === 'function') + ' fetch=' + (typeof fetch === 'function'),
      '页面环境: body=' + !!document.body + ' 深色模式=' + isDark() + ' 视口=' + window.innerWidth + 'x' + window.innerHeight,
      '入口模式: ' + cfg.entryMode,
      'B站原版放行: ' + (bypassNative
        ? ('进行中，剩 ' + Math.max(0, Math.ceil((bypassUntil - Date.now()) / 1000)) + ' 秒')
        : '未开启'),
      '原生牌子图标: ' + (findNativeEl(true) ? '找到，点击已接管' : '没找到（悬浮按钮兜底 / Alt+M 仍可用）'),
      '悬浮按钮: ' + (document.getElementById('blam-entry') ? '在' : '不在'),
      '聊天框锚点: ' + (anchorsHit.length ? anchorsHit.join(', ') : '一个都没找到'),
      '面板: ' + (document.getElementById('blam-panel')
        ? ('已打开 right=' + panelEl.style.right + ' bottom=' + panelEl.style.bottom
          + ' width=' + panelEl.style.width + ' maxH=' + panelEl.style.maxHeight)
        : '未打开'),
      '设置窗口: ' + (document.getElementById('blam-settings') ? '已打开' : '未打开'),
      '右侧栏: ' + (function () {
        const r = asideRect();
        return r ? (Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)) : '没找到（直接贴窗口右边）';
      })(),
      '输入框: ' + (function () {
        const r = inputRect();
        return r ? (Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)) : '没找到';
      })(),
      '自动换牌: ' + (cfg.enabled ? '开' : '关'),
      '主播 uid: ' + (state.uid || '未取得'),
      '本房间牌子 id: ' + (state.myMedalId || '无'),
      '佩戴中 id: ' + (state.wearingId || '无'),
      '最近状态: ' + lastStatus,
      '最近错误: ' + (lastError || '无')
    ].join('\n');
  }

  function copyText(txt) {
    if (typeof GM_setClipboard === 'function') {
      try { GM_setClipboard(txt, 'text'); return true; } catch (e) { /* ignore */ }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.parentNode.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  // ==================== 设置窗口（显示在网页主界面，改完点「保存」才生效） ====================
  // 设置项不再往油猴菜单里塞十来个命令：点「展开设置」直接在直播页面上开一个窗口。
  // 所有改动只写进 settingsDraft（内存草稿），只有点「保存」才 saveCfg() 并应用副作用；
  // 关窗口 / 点遮罩 / 按 Esc / 点「取消」都丢弃草稿，磁盘上的配置保持原样。
  let settingsBackdrop = null, settingsEl = null, settingsDraft = null;
  const SETTINGS_KEYS = ['enabled', 'notify', 'fallbackDefault', 'defaultMedalId', 'defaultMedalName', 'entryMode'];

  function settingsDirty() {
    if (!settingsDraft) return false;
    for (let i = 0; i < SETTINGS_KEYS.length; i++) {
      const k = SETTINGS_KEYS[i];
      if (cfg[k] !== settingsDraft[k]) return true;
    }
    return false;
  }

  function closeSettings(showHint) {
    const dirty = settingsDirty();
    if (settingsEl && settingsEl.parentNode) settingsEl.parentNode.removeChild(settingsEl);
    if (settingsBackdrop && settingsBackdrop.parentNode) settingsBackdrop.parentNode.removeChild(settingsBackdrop);
    settingsEl = settingsBackdrop = settingsDraft = null;
    if (showHint && dirty) toast('有未保存的修改，已放弃');
  }

  function saveSettings() {
    if (!settingsDraft) return;
    const wasEnabled = cfg.enabled;
    cfg = Object.assign({}, cfg, settingsDraft);
    saveCfg();
    closeSettings(false);
    refreshMenu();
    startEntryTimer();   // 入口方式改了，立刻按新配置挂上 / 撤掉悬浮按钮
    if (!wasEnabled && cfg.enabled) { retryStep = 0; failToastShown = false; run('设置里开启'); }
    toast('设置已保存并生效');
  }

  function stEl(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function addSwitch(body, key, label, desc) {
    const row = stEl('label', 'blam-st-row');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!settingsDraft[key];
    cb.onchange = function () { settingsDraft[key] = cb.checked; };
    const txt = stEl('div');
    txt.appendChild(stEl('div', 'blam-st-label', label));
    txt.appendChild(stEl('div', 'blam-st-desc', desc));
    row.appendChild(cb); row.appendChild(txt);
    body.appendChild(row);
    return cb;
  }

  function addSelectRow(body, label, desc, options, key) {
    const row = stEl('div', 'blam-st-row');
    row.style.display = 'block';
    row.appendChild(stEl('div', 'blam-st-label', label));
    row.appendChild(stEl('div', 'blam-st-desc', desc));
    const sel = stEl('select', 'blam-st-select');
    sel.style.marginTop = '7px';
    for (let i = 0; i < options.length; i++) {
      const o = document.createElement('option');
      o.value = String(options[i].value);
      o.textContent = options[i].label;
      sel.appendChild(o);
    }
    sel.value = String(settingsDraft[key]);
    sel.onchange = function () { settingsDraft[key] = sel.value; };
    row.appendChild(sel);
    body.appendChild(row);
    return sel;
  }

  function openSettings() {
    injectCSS();
    if (!document.body) return;
    if (settingsEl) { closeSettings(false); return; }
    if (state.panelOpen) closePanel();        // 两个面板不叠在一起
    if (bypassNative) endBypass();            // 回到脚本设置就退出原版放行窗口

    settingsDraft = Object.assign({}, cfg);
    const dark = isDark();

    settingsBackdrop = stEl('div');
    settingsBackdrop.id = 'blam-settings-backdrop';
    settingsBackdrop.onclick = function () { closeSettings(true); };

    settingsEl = stEl('div');
    settingsEl.id = 'blam-settings';
    if (dark) settingsEl.className = 'blam-dark';

    const head = stEl('div', 'blam-st-head');
    head.appendChild(stEl('div', 'blam-st-title', '粉丝牌助手 · 设置'));
    head.appendChild(stEl('div', 'blam-st-tip', 'v2.4.0'));
    const closeBtn = stEl('div', 'blam-st-close', '×');
    closeBtn.title = '放弃未保存的修改并关闭';
    closeBtn.onclick = function () { closeSettings(true); };
    head.appendChild(closeBtn);

    const body = stEl('div', 'blam-st-body');
    body.appendChild(stEl('div', 'blam-st-sec', '自动换牌'));
    addSwitch(body, 'enabled', '进房自动换牌', '进入直播间时自动佩戴该主播的粉丝牌');
    addSwitch(body, 'notify', '成功后提示', '换牌成功、切回默认牌时显示一条小提示');
    addSwitch(body, 'fallbackDefault', '没牌子时切回默认牌', '本房间没有粉丝牌时，改戴下面选中的默认牌');

    // ---- 默认牌：草稿值 + 下拉列表（可从已读到的粉丝牌里选，也可用当前房间的牌子） ----
    const medalRow = stEl('div', 'blam-st-row');
    medalRow.style.display = 'block';
    medalRow.appendChild(stEl('div', 'blam-st-label', '默认牌'));
    medalRow.appendChild(stEl('div', 'blam-st-desc', '配合「没牌子时切回默认牌」使用'));
    const medalSel = stEl('select', 'blam-st-select');
    medalSel.style.marginTop = '7px';
    medalRow.appendChild(medalSel);
    const medalHint = stEl('div', 'blam-st-hint', '');
    medalRow.appendChild(medalHint);
    const medalActions = stEl('div', 'blam-st-inline');
    medalRow.appendChild(medalActions);
    body.appendChild(medalRow);

    function updateMedalHint() {
      medalHint.textContent = settingsDraft.defaultMedalId
        ? ('当前草稿：' + (settingsDraft.defaultMedalName || ('ID ' + settingsDraft.defaultMedalId)))
        : '当前草稿：不设置默认牌';
    }

    function fillMedalOptions(list) {
      const keepId = settingsDraft.defaultMedalId;
      const keepName = settingsDraft.defaultMedalName;
      medalSel.innerHTML = '';
      const none = document.createElement('option');
      none.value = '0';
      none.textContent = '不设置默认牌';
      medalSel.appendChild(none);
      const seen = {};
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        const id = num(it.medalId || it.id);
        if (!id || seen[id]) continue;
        seen[id] = 1;
        const name = String(it.name || '粉丝牌');
        const o = document.createElement('option');
        o.value = String(id);
        o.textContent = name + (it.level ? '（Lv.' + it.level + '）' : '');
        o.dataset.name = name;
        medalSel.appendChild(o);
      }
      // 已经保存过的默认牌可能不在这一页里，补一个选项，别让它看起来「丢了」
      if (keepId && !seen[keepId]) {
        const o = document.createElement('option');
        o.value = String(keepId);
        o.textContent = (keepName || '默认牌') + '（已保存）';
        o.dataset.name = keepName || '';
        medalSel.appendChild(o);
      }
      medalSel.value = String(keepId || 0);
      updateMedalHint();
    }

    medalSel.onchange = function () {
      const o = medalSel.selectedOptions && medalSel.selectedOptions[0];
      const id = num(medalSel.value);
      settingsDraft.defaultMedalId = id;
      settingsDraft.defaultMedalName = id ? ((o && (o.dataset.name || o.textContent)) || '') : '';
      updateMedalHint();
    };

    function setDraftDefault(id, name) {
      id = num(id);
      settingsDraft.defaultMedalId = id;
      settingsDraft.defaultMedalName = id ? (name || '') : '';
      if (id) {
        let opt = null;
        for (let i = 0; i < medalSel.options.length; i++) {
          if (medalSel.options[i].value === String(id)) { opt = medalSel.options[i]; break; }
        }
        if (!opt) {
          opt = document.createElement('option');
          opt.value = String(id);
          opt.textContent = name || ('牌子 ' + id);
          medalSel.appendChild(opt);
        }
        opt.dataset.name = name || '';
        medalSel.value = String(id);
      } else {
        medalSel.value = '0';
      }
      updateMedalHint();
      toast(id ? ('已选「' + (name || '默认牌') + '」，点「保存」后生效') : '已清除默认牌，点「保存」后生效');
    }

    // 只读第一页，绝不碰 state / renderRows，免得影响正在展示的粉丝牌面板
    function loadMedalOptions(silent) {
      apiPanel(1).then(function (data) {
        if (!settingsEl || !settingsDraft) return;
        const raw = (Array.isArray(data.list) ? data.list : [])
          .concat(Array.isArray(data.special_list) ? data.special_list : []);
        const list = [];
        for (let i = 0; i < raw.length; i++) {
          const it = normItem(raw[i]);
          if (it) list.push({ medalId: it.medalId, name: it.name, level: it.level });
        }
        fillMedalOptions(list);
        if (!silent) toast('已读取 ' + list.length + ' 个粉丝牌');
      }).catch(function (e) {
        if (!silent && settingsEl) toast('牌子列表读取失败：' + (e && e.message ? e.message : e));
      });
    }

    const btnCurrent = stEl('button', 'blam-st-btn', '用当前房间的牌子');
    btnCurrent.type = 'button';
    btnCurrent.onclick = async function () {
      const roomId = readRoomId();
      if (!roomId) { toast('先进入一个直播间'); return; }
      try {
        const uid = await resolveUid(roomId);
        const m = await findMedal(uid, roomId);
        if (!m) { toast('你没有这个主播的粉丝牌'); return; }
        setDraftDefault(m.id, m.name);
      } catch (e) { toast('读取失败：' + (e && e.message ? e.message : e)); }
    };
    const btnClear = stEl('button', 'blam-st-btn', '清除默认牌');
    btnClear.type = 'button';
    btnClear.onclick = function () { setDraftDefault(0, ''); };
    const btnReload = stEl('button', 'blam-st-btn', '刷新牌子列表');
    btnReload.type = 'button';
    btnReload.onclick = function () { loadMedalOptions(false); };
    medalActions.appendChild(btnCurrent);
    medalActions.appendChild(btnClear);
    medalActions.appendChild(btnReload);

    body.appendChild(stEl('div', 'blam-st-sec', '面板入口'));
    addSelectRow(body, '打开方式', '决定从哪里打开粉丝牌面板，改完需点「保存」', [
      { value: 'native', label: 'B 站原生粉丝牌图标（推荐）' },
      { value: 'float', label: '悬浮小按钮「牌」' },
      { value: 'both', label: '两者都有' }
    ], 'entryMode');

    body.appendChild(stEl('div', 'blam-st-sec', '快捷操作'));
    const actions = stEl('div', 'blam-st-actions');
    function addAction(text, fn) {
      const b = stEl('button', 'blam-st-btn', text);
      b.type = 'button';
      b.onclick = fn;
      actions.appendChild(b);
    }
    addAction('打开粉丝牌面板', function () { closeSettings(false); togglePanel(); });
    addAction('立即重新换一次', function () { retryStep = 0; toast('正在重新换牌…'); run('手动触发'); });
    addAction('查看运行状态', function () {
      toast('房间 ' + (readRoomId() || '?')
        + ' | 登录：' + (getCookie('bili_jct') ? '正常' : '没读到，请先登录 B 站')
        + ' | ' + lastStatus
        + (cfg.defaultMedalName ? ' | 默认牌：' + cfg.defaultMedalName : ''), 7000);
    });
    addAction('复制诊断信息', function () {
      const txt = diagText();
      try { console.log('[粉丝牌面板] 诊断信息\n' + txt); } catch (e) { /* ignore */ }
      toast(copyText(txt) ? '诊断信息已复制，直接粘贴发给开发者即可' : ('诊断：' + lastStatus), 5000);
    });
    body.appendChild(actions);
    body.appendChild(stEl('div', 'blam-st-hint',
      '改动只保存在草稿里，点右下角「保存」才会写入并生效；直接关闭窗口即放弃修改。'));

    const footEl = stEl('div', 'blam-st-foot');
    footEl.appendChild(stEl('div', 'blam-st-foot-tip', 'Alt+M 面板 · Esc 关闭'));
    const cancel = stEl('button', 'blam-st-cancel', '取消');
    cancel.type = 'button';
    cancel.onclick = function () { closeSettings(true); };
    const save = stEl('button', 'blam-st-save', '保存');
    save.type = 'button';
    save.onclick = saveSettings;
    footEl.appendChild(cancel);
    footEl.appendChild(save);

    settingsEl.appendChild(head);
    settingsEl.appendChild(body);
    settingsEl.appendChild(footEl);
    document.body.appendChild(settingsBackdrop);
    document.body.appendChild(settingsEl);

    fillMedalOptions(state.all);
    // 还没打开过粉丝牌面板时，静默拉一次列表，让默认牌有得选
    if (!state.all.length) loadMedalOptions(true);
  }

  // ==================== 油猴菜单（固定 2 项，设置全部走页面内窗口） ====================
  let menuIds = [];
  function refreshMenu() {
    if (typeof GM_unregisterMenuCommand === 'function') {
      for (let i = 0; i < menuIds.length; i++) {
        try { GM_unregisterMenuCommand(menuIds[i]); } catch (e) { /* ignore */ }
      }
    }
    menuIds = [];
    function reg(label, fn) {
      if (typeof GM_registerMenuCommand === 'function') {
        try { menuIds.push(GM_registerMenuCommand(label, fn)); } catch (e) { /* ignore */ }
      }
    }
    reg('自动换牌：[' + (cfg.enabled ? '开' : '关') + '] 点击切换', function () {
      cfg.enabled = !cfg.enabled; saveCfg(); refreshMenu();
      toast(cfg.enabled ? '自动换牌已开启' : '自动换牌已关闭');
      if (cfg.enabled) { retryStep = 0; run('手动开启'); }
    });

    reg('展开设置（在网页里修改并保存）', openSettings);
  }

  refreshMenu();

  // ==================== 启动 ====================
  lastRoom = readRoomId();
  state.roomId = lastRoom;
  injectCSS();
  run('脚本启动');

  // 启动时给一次极短的可见反馈：让人一眼确认脚本在跑（不像之前那样完全静默）
  if (lastRoom && cfg.notify) {
    setTimeout(function () {
      if (!cfg.enabled) return;
      const hasNative = !!findNativeEl();
      const tip = cfg.entryMode === 'both'
        ? '点原生粉丝牌图标（或右侧「牌」）'
        : (cfg.entryMode === 'float' || !hasNative ? '点右侧「牌」' : '点聊天框旁的粉丝牌图标');
      toast('粉丝牌助手已就绪，' + tip + ' 打开面板（Alt+M 也行）', 2600);
    }, 1600);
  }
})();

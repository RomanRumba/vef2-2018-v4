/* -------------------------------------
   ----------REQUIRES START-------------
   -------------------------------------  */
require('dotenv').config();
require('isomorphic-fetch');

const redis = require('redis');
const util = require('util');
const cheerio = require('cheerio');

/* -------------------------------------
   ----------REQUIRES END --------------
   -------------------------------------  */

/* -------------------------------------
   ------- UpphafStillingar START ------
   -------------------------------------  */

const expire = 7200;
// Stillingar sem redis mun nota
const redisOptions = {
  url: 'redis://127.0.0.1:6379/0',
};

// Buið til so called client sem notar redisOptions
const client = redis.createClient(redisOptions);

// Getters og Setters binduð á client
const asyncGet = util.promisify(client.get).bind(client);
const asyncSet = util.promisify(client.set).bind(client);
// svo það er hægt að sækja marga lykla
const asyncKeys = util.promisify(client.keys).bind(client);
// svo það er hæght að eyða lykla
const asyncDel = util.promisify(client.del).bind(client);

// json obj sem inniheldur slóðir á töflurnar á HI vefnum
const departmentUrls = {
  felagsvisindasvid: 'https://ugla.hi.is/Proftafla/View/ajax.php?sid=2027&a=getProfSvids&proftaflaID=37&svidID=1&notaVinnuToflu=0',
  heilbrigdisvisindasvid: 'https://ugla.hi.is/Proftafla/View/ajax.php?sid=2027&a=getProfSvids&proftaflaID=37&svidID=2&notaVinnuToflu=0',
  hugvisindasvid: 'https://ugla.hi.is/Proftafla/View/ajax.php?sid=2027&a=getProfSvids&proftaflaID=37&svidID=3&notaVinnuToflu=0',
  menntavisindasvid: 'https://ugla.hi.is/Proftafla/View/ajax.php?sid=2027&a=getProfSvids&proftaflaID=37&svidID=4&notaVinnuToflu=0',
  'verkfraedi-og-natturuvisindasvid': 'https://ugla.hi.is/Proftafla/View/ajax.php?sid=2027&a=getProfSvids&proftaflaID=37&svidID=5&notaVinnuToflu=0',
};

/**
 * Listi af sviðum með „slug“ fyrir vefþjónustu og viðbættum upplýsingum til
 * að geta sótt gögn.
 */
const departments = [
  {
    name: 'Félagsvísindasvið',
    slug: 'felagsvisindasvid',
  },
  {
    name: 'Heilbrigðisvísindasvið',
    slug: 'heilbrigdisvisindasvid',
  },
  {
    name: 'Hugvísindasvið',
    slug: 'hugvisindasvid',
  },
  {
    name: 'Menntavísindasvið',
    slug: 'menntavisindasvid',
  },
  {
    name: 'Verkfræði- og náttúruvísindasvið',
    slug: 'verkfraedi-og-natturuvisindasvid',
  },
];

/* -------------------------------------
   ------- UpphafStillingar END --------
   -------------------------------------  */

/* Notkun : getDataFromNet(url)
   Fyrir  : url er slóð á siðu sem getur skilað einhverju sem er hægt að vinna úr
   Efitr  : Gerir Getrequest á url og ef statuskóði var 200 þá er skilað gögnum
            sem var sent frá url annars skilað null */
async function getDataFromNet(url) {
  const response = await fetch(url); // gert getrequest á url
  // ef status kóði 200 þá skilum það sem var fengið
  if (response.status === 200) {
    const text = await response.text();
    return text;
  }
  // annars skilað null
  return null;
}

/* Notkun :  parseNetData(data)
   Fyrir  :  data er stór strengur sem er með á json upsetninguni
             þar sem það hefur einn parameter sem er html
   Efitr  :  skilar fylki = [[svið-1],[svið-2], ....[svið-n]]
    þar sem eitt svið er svið = {
                                 heading <- stengur
                                 tests:[]
                                }
    þar sem fylki tests = [
                            {
                               course: <-strengur
                               name: <-strengur
                               type: <-strengur
                               students: <-Number
                               date: <-strengur
                            },...
                          ] */
function parseNetData(data) {
  // parsa þennan streng sem json obj svo það er hægt að vinna með hann
  const jsonObj = JSON.parse(data);
  // hlöðum upp cheerio með html gönum
  const $ = cheerio.load(jsonObj.html);
  const test = []; // fylkið sem mun innihalda öll gögn

  /* Upsetning á HI vefnum er titill af prófi sem er i h3 elementi
     svo næsta Noðan er table sem geymir gögn fyrir sed próf
     þannig það er leitað af öllum h3 og svo frá h3 tögum er náð i töflunar */
  $('.box').find('h3').each((i, el) => {
    const currEl = $(el); // current h3 element
    const currTable = currEl.next(); // næsta noðan eftir h3 er table
    const testsArray = []; // inniheldur öll próf i sed töflu

    /* ná i firsta tbody i table þótt table hefur eitt tbody það er gott að tryggja
      svo er leitað af öllum börnum tr i tbody og það er bætt þeim i json obj */
    $(currTable.children('tbody').first().children('tr')).each((trpos, currtr) => {
      testsArray.push({
        course: $(currtr).find('td').eq(0).text(),
        name: $(currtr).find('td').eq(1).text(),
        type: $(currtr).find('td').eq(2).text(),
        students: Number($(currtr).find('td').eq(3).text()), // viljum hafa int
        date: $(currtr).find('td').eq(4).text(),
      });
    });

    // json obj af einni töflu
    test.push({
      // heading er nafn á deild trim tekur óþarfa bilin i burt
      heading: currEl.text().trim(),
      tests: testsArray,
    });
  });
  return test;
}

/**
 * Sækir svið eftir `slug`. Fáum gögn annaðhvort beint frá vef eða úr cache.
 *
 * @param {string} slug - Slug fyrir svið sem skal sækja
 * @returns {Promise} Promise sem mun innihalda gögn fyrir svið eða null ef það finnst ekki
 */
async function getTests(slug) {
  // Byrjað að ath hvort gögnin eru cached á redis
  const iscached = await asyncGet(`department:${slug}`);
  // Ef Gögn eru cached þá skilum þau og þá er það komið
  if (iscached) {
    return JSON.parse(iscached);
  }
  // ef gögnin eru ekki til þá þarf að sækja þau
  const result = await getDataFromNet(departmentUrls[slug]);
  // pörsum sed gögn
  const parsedRes = await parseNetData(result);

  /* þvi redis tekur bara við strengi við getum breytt parsed gögn með json stringify
     til að geyma gögn á strengja formi svo muna að parse gögn þegar er sótt ur minni.
     svo öll gögn sem eru i redis endast i 2klst eða 7200 sec */
  await asyncSet(`department:${slug}`, JSON.stringify(parsedRes), 'EX', expire);

  return parsedRes;
}

/**
 * Hreinsar cache.
 *
 * @returns {Promise} Promise sem mun innihalda boolean um hvort cache hafi verið hreinsað eða ekki.
 */
async function clearCache() {
  // sótt alla lykkla á formi 'department:xxx'
  const keys = await asyncKeys('department:*');
  if (keys.length === 0) {
    /* NOTICE !!!! miðað við notkunarlýsingar ef það eru eingin lyklar þá þarf ekki
       að hreinsa minnið þannig það er óssat ? */
    return true;// eða false ?
  }
  // ef það eru til gögn þá eyðum þau
  await asyncDel.apply(client, keys);
  // reynum að leita af þeim aftur til að vera viss
  const res = await asyncKeys('department:*');
  // ef þau eru til for some unknow reason þá skilum óssat
  if (res.length !== 0) {
    return false;
  }
  return true; // gögn voru eydd
}

/**
 * Sækir tölfræði fyrir öll próf allra deilda allra sviða.
 *
 * @returns {Promise} Promise sem mun innihalda object með tölfræði um próf
 */
async function getStats() {
  const allTests = []; // mun innihalda öll svið og upplysingar um sed svið

  // ------------- breytur fyrir dæmi START ---------------
  let heildarfjoldiprofa = 0;
  let heildarfjoldiOllumProfum = 0;
  let profFaestNem = Number.POSITIVE_INFINITY;
  let profMestNem = Number.NEGATIVE_INFINITY;
  // ------------- breytur fyrir dæmi END -----------------

  /* ég vildi nota first for(const svi in departmentUrls ) sem virkaði
     en eslint kvartaði of mikið þannig ég harðkóðaði þetta.
     endurnota getTests fallið þvi það er fullkomið  */
  allTests.push(await getTests('felagsvisindasvid'));
  allTests.push(await getTests('heilbrigdisvisindasvid'));
  allTests.push(await getTests('hugvisindasvid'));
  allTests.push(await getTests('menntavisindasvid'));
  allTests.push(await getTests('verkfraedi-og-natturuvisindasvid'));

  // Reikna stats NOTICE MÆLI MEÐ AÐ SKOÐA NotknuarLýsingu fyrir getTests
  allTests.forEach((svid) => { // fyrir hvert svið
    Object.keys(svid).forEach((deild) => { // i hverju svið er deild
      svid[deild].tests.forEach((test) => { // hver deild hefur próf
        heildarfjoldiprofa += 1;
        heildarfjoldiOllumProfum += test.students;
        if (test.students < profFaestNem) {
          profFaestNem = test.students;
        }
        if (test.students > profMestNem) {
          profMestNem = test.students;
        }
      });
    });
  });
  // reikna meðalfjölda nema með 2 aukastöfum
  const medalfjöldinemanda = Math.ceil((heildarfjoldiOllumProfum / heildarfjoldiprofa) * 100) / 100;
  const stats = {
    min: profFaestNem,
    max: profMestNem,
    numTests: heildarfjoldiprofa,
    numStudents: heildarfjoldiOllumProfum,
    averageStudents: medalfjöldinemanda,
  };

  return stats;
}

module.exports = {
  departments,
  getTests,
  clearCache,
  getStats,
};

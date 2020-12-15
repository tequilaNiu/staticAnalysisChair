#!/usr/bin/env node
const program = require('commander');
const fs = require('vinyl-fs');
const map = require('map-stream');
const espree = require('espree');
const esquery = require('esquery');
const _get = require('lodash/get');
const _find = require('lodash/find');
const _cloneDeep = require('lodash/cloneDeep');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const open = require('open');
const cliProgress = require('cli-progress');
const toHump = require('./util.js');

const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
let root_tree = [];
const service_tree = [];
const controller_tree = [];
let file_count = 0;
let finish_count = 0; 

const analyze = path => {
  const analyzeController = analyzeService = (file, type) => {
    // console.log(`路径： ${file.path}`);
    const ast = espree.parse(file.contents.toString(), { ecmaVersion: 9 })

    // 选择class下的所有method
    let class_method_ast_nodes = esquery(ast, 'ClassDeclaration > ClassBody > MethodDefinition');



    if (class_method_ast_nodes.length === 0) {
      class_method_ast_nodes = esquery(ast, 'ExpressionStatement>AssignmentExpression:has([left.object.name="exports"]) :matches(FunctionExpression, ArrowFunctionExpression)');
    }

    // 遍历method, 返回每个方法中的调用集
    const ctx_ast_nodes = class_method_ast_nodes.map(node => {
      /**
       * 选择所有callee
       * ctx.[service|drm|proxy].[...string]()形式
       * this.ctx.[service|drm|proxy].[...string]()形式
       * const { service } = this; service.[...string]()形式
       */
      const callee_ast_nodes = esquery(node, 'ExpressionStatement>CallExpression>.callee:has(\
        [property.name="service"][object.name="ctx"],\
        [property.name="service"][object.property.name="ctx"],\
        [property.name="service"][object.type="ThisExpression"],\
        [object.name="service"],\
        [property.name="service"],\
        [property.name="drm"][object.name="ctx"],\
        [property.name="drm"][object.property.name="ctx"],\
        [property.name="drm"][object.type="ThisExpression"],\
        [property.name="proxy"][object.name="ctx"],\
        [property.name="proxy"][object.property.name="ctx"],\
        [property.name="proxy"][object.type="ThisExpression"]\
      ):not([object.callee])');

      /**
       * this.[method != 'ctx|service|drm|proxy|fengdie']
       */
      const callee_this_ast_nodes = esquery(node, 'ExpressionStatement>CallExpression>.callee:has(\
        [object.type="ThisExpression"][property.name!="ctx"][property.name!="logger"][property.name!="service"][property.name!="fengdie"][property.name!="proxy"][property.name!="drm"]\
      )');

      /**
       * fengdie MemberExpression
       * this.ctx.fengdie.xx
       * ctx.fengdie.xx
       * xx(this.ctx.fengdie.yy)
       * xx(ctx.fengdie.yy)
       */
      const fengdie_declare_ast_nodes = esquery(node, 'MemberExpression:has(MemberExpression :has(\
        [property.name="fengdie"][object.name="ctx"],\
        [property.name="fengdie"][object.property.name="ctx"],\
        [property.name="fengdie"][object.type="ThisExpression"]\
      ))');

      console.log('>>>>>>>>>>start<<<<<<<<<<');
      console.log('callee>>>', callee_ast_nodes);
      console.log('this>>>', callee_this_ast_nodes);
      console.log('fengdie>>>', fengdie_declare_ast_nodes)
      console.log('>>>>>>>>>>end<<<<<<<<<<');

      return {
        method_name: _get(node, 'key.name', '') || _get(...esquery(ast, 'AssignmentExpression .left:has([object.name="exports"])'), 'property.name', ''),
        callee: [
          ...callee_ast_nodes,
          ...callee_this_ast_nodes,
          ...fengdie_declare_ast_nodes,
        ],
      };
    });

    return;

    ctx_ast_nodes.forEach(node => {
      const { method_name, callee } = node || {};

      if (method_name) {
        while(callee.length) {
          let ast = callee.pop();
          ast = ast.callee || ast;
          let callee_name = '';
          let should_next_step = false;

          do {
            const temp_name = _get(ast, 'property.name', '')
              || _get(ast, 'name', '')
              || (_get(ast, 'type', '') === 'ThisExpression' ? 'this' : '');
            if (temp_name) callee_name = callee_name ? `${temp_name}.${callee_name}` : temp_name;
            else {
              should_next_step = true;
              break;
            }
            ast = ast.object;
          } while(ast)

          if (!should_next_step) {
            // 不靠谱的判断 this.xx()
            const callee_name_str_list = callee_name.split('.');
            if (callee_name_str_list.length === 2) {
              const regexp = /(?!=wealthbffweb\/)(app\S+)(?=(\.js|\.ts))/g;
              const temp_path_name = file.path.match(regexp);
              if (temp_path_name && temp_path_name.length === 1) {
                callee_name = `${toHump(temp_path_name[0])}/${callee_name_str_list[1]}`.split('/').join('.').replace('.controllers.', '.controller.');
              }
            }

            // 统一格式化一把
            callee_name = callee_name.replace(/(.*(?=service\.))/, 'app.');
            callee_name = callee_name.replace(/(.*(?=controller\.))/, 'app.');
            callee_name = callee_name.replace(/(.*(?=drm\.))/, 'app.');
            callee_name = callee_name.replace(/(.*(?=fengdie\.))/, 'app.');
            callee_name = callee_name.replace(/(.*(?=proxy\.))/, 'app.');

            node.children ? node.children.push({ key: callee_name }) : node.children = [{ key: callee_name }];
          }
        }

        // node.method_name
        node.key = node.method_name;
        const regexp = /(?!=wealthbffweb\/)(app\S+)(?=(\.js|\.ts))/g;
        const temp_path_name = file.path.match(regexp);
        if (temp_path_name && temp_path_name.length === 1) {
          node.key = `${toHump(temp_path_name[0])}/${node.method_name}`.split('/').join('.').replace('.controllers.', '.controller.');
        }
        Reflect.deleteProperty(node, 'method_name');
        Reflect.deleteProperty(node, 'callee');
      }
    });


    if (type === 'service') {
      service_tree.push(...ctx_ast_nodes);
    }

    if (type === 'controller') {
      controller_tree.push(...ctx_ast_nodes);
    }
  }

  const analyzeRouter = file => {
    const file_text = file.contents.toString();
    const regexp_rpc = /(?!=\')[a-zA-Z0-9.]+(?=\'\,)/gm;
    const regexp_path = /(?!=\,[\s]*)[a-zA-Z0-9.]+(?=\))/gm;

    const rpc_list = file_text.match(regexp_rpc);
    const path_list = file_text.match(regexp_path);

    // 硬性判断一波
    if (rpc_list.length != path_list.length) return;

    root_tree = rpc_list.map((rpc, index) => ({
      key: rpc,
      children: [{
        key: path_list[index],
      }],
    }));
  }

  const __loop = (tree, key, node) => {
    const page = _find(tree, { key });
    const { children } = page || {};
    node.id = uuidv4();
    node.collapsed = true;
    if (!children) {
      return;
    }

    node.children = _cloneDeep(children);
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const { key: child_key } = child;
      if (child_key.indexOf('.service.') > -1) {
        __loop(service_tree, child_key, child);
      } else if (child_key.indexOf('.controller.') > -1) {
        __loop(controller_tree, child_key, child);
      }
      child.id = uuidv4();
      child.collapsed = true;
    }
  }

  fs.src([path, '!node_modules/**/*'])
    .pipe(map((file, cb) => {
      // file_count++;
      // if (file.path.indexOf('router.js') > -1) {
      //   analyzeRouter(file);
      // } else if (file.path.indexOf('app/service') > -1) {
      //   analyzeService(file, 'service');
      // } else if (file.path.indexOf('app/controllers') > -1) {
      //   analyzeController(file, 'controller');
      // }

      console.log('>>>>>');
      analyzeController(file, 'service');

      // finish_count++;
      // bar.increment(finish_count);
      cb(null, file);
    }))
    .on('end', () => {
      // root_tree.forEach(root => {
      //   root.id = uuidv4();
      //   __loop(controller_tree, root.children[0].key, root.children[0]);
      // });

      // const ffs = require('fs');
      // const writeStream = ffs.createWriteStream(`${__dirname}/public/result.json`);
      // writeStream.write(JSON.stringify({ key: 'wealthbff', children: root_tree, id: uuidv4() }));
      // bar.stop();
      // server();
    });
}

const server = () => {
  const app = express();
  const port = 3000;

  app.use(express.static(`${__dirname}/public`));

  app.listen(port, () => {
    console.log(`Example app listening at http://localhost:${port}`);
    (async () => {
      await open(`http://localhost:${port}`);
    })();
  });
};

program
  .version('0.0.1');

program
  .command('go')
  .alias('g')
  .description('静态解析eggjs项目中的引用关系')
  .option('-p, --path <path>', '项目根目录')
  .option('-pn, --project_name <project_name>', '项目名称 --正则匹配用')
  .option('-sp, --source_path <source_path>', '存放controller/router/service的路径')
  .action(params => {
    const {
      path = `${__dirname}/../test/funs.js`,
      project_name = 'wealthbffweb',
      source_path = 'app',
    } = params || {};

    analyze(path);
  });
  // .action((path = `${__dirname}/../test/funs.js`, otherParams = '') => {
  //   console.log('>>>>', path)
  //   // bar.start(212623132, 0, {
  //   //   speed: 'N/A',
  //   // });
  //   // 分析文件结构
  //   // analyze(path);
  // });

program.parse(process.argv);

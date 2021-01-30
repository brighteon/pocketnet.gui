
var Node = require('./node');
var Datastore = require('nedb');
var _ = require('lodash');
var f = require('../functions');

var Nodemanager = function(p){
    if(!p) p = {};


    var self = this;

    self.nodes = [];
    self.nodesmap = {};

    self.askedpeers = {}

    var findInterval = null

    var db = new Datastore(f.path(p.dbpath));
   
    self.remap = function(){
        self.nodesmap = {};

        _.each(self.nodes, function(node){
            self.nodesmap[node.key] = node
        })
    }

    self.revoke = function(_p, admin){
        var unode = new Node(_p, self)

        var node = self.nodesmap[unode.key]

        if (node && node.addedby && (node.addedby == unode.addedby || admin)){

            self.remove(unode.key)

            self.remap()

            return new Promise((resolve, reject) => {
                db.remove({ key: unode.key }, { multi: true }, function (err, numRemoved) {
                    if(err) return reject(err)
                    resolve(node)
                });
            })
        }

        else
        return Promise.reject('cantremove')


    }

    self.update = function(_p, admin){

        var unode = new Node(_p)

        var node = self.nodesmap[unode.key]

        return unode.check().then(r => {

            if (node && node.addedby && (node.addedby == unode.addedby || admin)){

                var updated = node.update(unode)

                node.statistic.clear()
                
                return new Promise((resolve, reject) => {
                    db.update({ key: unode.key }, { $set: { data: updated } }, {}, function (err) {
                        if(err) return reject(err)
                        resolve(node)
                    });
                })
            }
    
            else{
                return Promise.reject('cantupdate')
            }

        })
        
    }

    self.temp = function(_p){

        var node = new Node(_p, self)

        return node
        
    }

    self.remove = function(key){
        var node = self.nodesmap[key]

        if (node){
            node.destroy()

            node.removed = true

            self.nodes = _.filter(self.nodes, function(node){
                return !node.removed
            })

            self.remap()
        }

        
    }

    self.add = function(node){
        if(!self.nodesmap[node.key]){
            self.nodes.push(node);

            self.remap()

            node.init()
        }
    }
    
    self.create = function(p){

        if(!p.addedby) return Promise.reject('unathorized')

        var node = new Node(p)

        if(node.localhost()) return Promise.reject('localhost')

        return node.check().then(r => {

            self.add(node);

            return new Promise((resolve, reject) => {
                db.insert(node.export()).exec(function (err, docs) {
                    if(err) return reject(err)
                    resolve(docs)
                })
            })
             
        })
        
    }

    self.currentChainCommon = function(){

        if(!self.nodes.length) return null

        var commonHeight = 0,
            commonBlockHash = '',
            maxHeight = 0;

        var lastblocks = _.filter(_.map(self.nodes, function(node){
            return node.lastblock()
        }), lb => {return lb})
        
        if(!lastblocks.length) return null

        maxHeight = _.maxBy(lastblocks, function(r){ return r.height }).height

        var hlastblocks = f.group(lastblocks, function(lb){ return lb.height })

        var kmc = 0

        _.each (hlastblocks, function(b, i){
            if (b.length > kmc || (b.length >= kmc && commonHeight < i) ) {
                kmc = b.length
                commonHeight = i
            }
        })

        var halastblocks = f.group(lastblocks, function(lb){ return lb.blockhash })

        var hmc = 0

        _.each (halastblocks, function(b, i){
            if (b.length > hmc || (b.length >= hmc && commonHeight < i) ) {
                hmc = b.length
                commonBlockHash = i
            }
        })

        var c = _.reduce(self.nodes, function(s, n){
            return s + (n.chain() || []).length
        }, 0) / self.nodes.length

        return {
            commonHeight : commonHeight,
            maxHeight : maxHeight,
            commonBlockHash : commonBlockHash,
            chainlength : c
        }

    }

    self.getnodes = function(){

        return _.map(self.nodes, function(node){
            return {
                node : node.exportsafe(),
                statistic : node.statistic.get(),
                status : node.chainStatus()
            }
        })

    }

    self.info = function(){
        var stats = {
            count : self.nodes.length,

            countuse : _.filter(self.nodes, function(node){
                return node.export().canuse
            }).length,

            nodes : self.getnodes(),

            chain : self.currentChainCommon()
        }

        return stats
    }

    self.init = function(){

        return new Promise((resolve, reject) => {
            db.loadDatabase(err => {

                db.ensureIndex({ fieldName: 'key', unique: true });

                db.find({}).exec(function (err, docs) {

                    self.nodes = []

                    _.each([].concat(p.stable, docs || []) , function(options){

                        var node = new Node(options, self)

                        self.add(node)
                    })

                    findInterval = setInterval(function(){
                        self.find()
                    }, 3000)

                    resolve()

                })
            })
        })  
        
    }

    self.find = function(){

        _.each(self.nodes, function(node){
            self.api.peernodesTime(node).catch(e => {})
        })

    }

    self.destroy = function(){

        _.each(self.nodes, function(node){
            node.destroy()
        })

        self.nodes = []
        self.remap()

        if (findInterval) {
            clearInterval(findInterval)

            findInterval = null
        }
    }

    self.selectbest = function(){

        var canuse = _.filter(self.nodes, function(node) { return node.export().canuse })

        var best = _.max(canuse, function(node){
            return node.statistic.rating()
        })


        if(!best || !best.statistic.rating()){
            best = _.find(self.nodes, function(node){
                return node.stable
            })
        }

        return best
    }


    //// ??
    self.select = function(n){

        if(!self.nodes.length){
            return null
        }

        var i = rand(1, self.nodes.length) - 1

        if(!n || n == 'auto'){
            return self.nodes[i]
        }

        return self.nodesmap[n]

    }

    self.request = function(method, parameters){
   
        var node = self.selectbest()


        if(!node) return Promise.reject('node')


        return node.rpcs(method, parameters)
    }
    
    self.api = {


        ///
        connected : function(nodes){
            var connected = []

            var promises = _.map(nodes, function(node){
                return node.info().then(r => {
                    connected.push(node)
                })
            })

            return Promise.all(promises).catch(e => {

                return Promise.resolve()
            }).then(r => {
                return Promise.resolve(connected)
            })

        },  
        
        peernodesTime : function(node){

            var last = self.askedpeers[node.key]

            if(!last || f.date.addseconds(last, 5 * 60) < new Date()){
                return self.api.peernodes(node).then(r => {

                    self.askedpeers[node.key] = new Date()
    
                    return Promise.resolve()
                })
            }   
            

            return Promise.resolve()
        },
       
        peernodes : function(node){
  
            return node.peers().then(nodes => {

                nodes = _.filter(nodes, function(n){
                    return !self.nodesmap[n.key]
                })

                return self.api.connected(nodes)
                
            }).then(connected => {

                _.each(connected, function(node){
                    self.add(node)
                })

                self.remap()

                return Promise.resolve(connected)
            })
        },

      
    
    }

   
		
    return self;
}

module.exports = Nodemanager